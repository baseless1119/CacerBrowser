//! Native Windows Common Item / Common File dialogs via direct Win32 FFI.
//! Avoids spawning PowerShell (which overrides thread UI culture to en-US and
//! adds cold-start lag) so dialogs open instantaneously and always follow the
//! active Windows display language.
use std::ffi::c_void;
use std::path::Path;
use std::ptr::{null, null_mut};

#[cfg(windows)]
mod imp {
    use super::*;

    type HResult = i32;
    type Bool = i32;

    const COINIT_APARTMENTTHREADED: u32 = 0x2;
    const COINIT_DISABLE_OLE1DDE: u32 = 0x4;
    const CLSCTX_INPROC_SERVER: u32 = 0x1;
    const S_OK: HResult = 0;
    const HRESULT_CANCELLED: HResult = 0x800704C7u32 as i32;

    const OFN_OVERWRITEPROMPT: u32 = 0x0000_0002;
    const OFN_NOCHANGEDIR: u32 = 0x0000_0008;
    const OFN_PATHMUSTEXIST: u32 = 0x0000_0800;
    const OFN_FILEMUSTEXIST: u32 = 0x0000_1000;
    const OFN_EXPLORER: u32 = 0x0008_0000;

    const FOS_NOCHANGEDIR: u32 = 0x0000_0008;
    const FOS_PICKFOLDERS: u32 = 0x0000_0020;
    const FOS_FORCEFILESYSTEM: u32 = 0x0000_0040;
    const SIGDN_FILESYSPATH: u32 = 0x8005_8000;

    #[repr(C)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }

    const CLSID_FILE_OPEN_DIALOG: Guid = Guid {
        data1: 0xDC1C_5A9C,
        data2: 0xE88A,
        data3: 0x4DDE,
        data4: [0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7],
    };
    const IID_IFILE_OPEN_DIALOG: Guid = Guid {
        data1: 0xD57C_7288,
        data2: 0xD4AD,
        data3: 0x4768,
        data4: [0xBE, 0x02, 0x9D, 0x96, 0x95, 0x32, 0xD9, 0x60],
    };
    const IID_ISHELL_ITEM: Guid = Guid {
        data1: 0x4382_6D1E,
        data2: 0xE718,
        data3: 0x42EE,
        data4: [0xBC, 0x55, 0xA1, 0xE2, 0x61, 0xC3, 0x7B, 0xFE],
    };

    #[repr(C)]
    pub(super) struct OpenFileNameW {
        l_struct_size: u32,
        hwnd_owner: *mut c_void,
        h_instance: *mut c_void,
        lpstr_filter: *const u16,
        lpstr_custom_filter: *mut u16,
        n_max_cust_filter: u32,
        n_filter_index: u32,
        lpstr_file: *mut u16,
        n_max_file: u32,
        lpstr_file_title: *mut u16,
        n_max_file_title: u32,
        lpstr_initial_dir: *const u16,
        lpstr_title: *const u16,
        flags: u32,
        n_file_offset: u16,
        n_file_extension: u16,
        lpstr_def_ext: *const u16,
        l_cust_data: isize,
        lpfn_hook: *mut c_void,
        lp_template_name: *const u16,
        pv_reserved: *mut c_void,
        dw_reserved: u32,
        flags_ex: u32,
    }

    #[link(name = "comdlg32")]
    extern "system" {
        fn GetOpenFileNameW(lpofn: *mut OpenFileNameW) -> Bool;
        fn GetSaveFileNameW(lpofn: *mut OpenFileNameW) -> Bool;
        fn CommDlgExtendedError() -> u32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> *mut c_void;
    }

    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(reserved: *mut c_void, coinit: u32) -> HResult;
        fn CoUninitialize();
        fn CoCreateInstance(
            rclsid: *const Guid,
            outer: *mut c_void,
            clsctx: u32,
            riid: *const Guid,
            ppv: *mut *mut c_void,
        ) -> HResult;
        fn CoTaskMemFree(pv: *mut c_void);
    }

    #[link(name = "shell32")]
    extern "system" {
        fn SHCreateItemFromParsingName(
            psz_path: *const u16,
            pbc: *mut c_void,
            riid: *const Guid,
            ppv: *mut *mut c_void,
        ) -> HResult;
    }

    struct ComGuard(bool);
    impl ComGuard {
        fn init() -> Self {
            let hr = unsafe { CoInitializeEx(null_mut(), COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
            // S_OK (0) or S_FALSE (1) both mean COM is initialized and needs CoUninitialize.
            Self(hr == 0 || hr == 1)
        }
    }
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn to_filter_wide(filter: &str) -> Vec<u16> {
        let mut out = Vec::new();
        for part in filter.split('|') {
            out.extend(part.encode_utf16());
            out.push(0);
        }
        if out.is_empty() {
            out.push(0);
        }
        out.push(0);
        out
    }

    fn from_wide_ptr(ptr: *const u16) -> String {
        if ptr.is_null() {
            return String::new();
        }
        let mut len = 0usize;
        unsafe {
            while *ptr.add(len) != 0 {
                len += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
        }
    }

    fn default_ext(default_name: Option<&str>, filter: Option<&str>) -> Option<Vec<u16>> {
        if let Some(name) = default_name {
            if let Some(ext) = Path::new(name).extension().and_then(|e| e.to_str()) {
                if !ext.is_empty() && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
                    return Some(to_wide(ext));
                }
            }
        }
        if let Some(f) = filter {
            if let Some(pattern) = f.split('|').nth(1) {
                if let Some(first) = pattern.split(';').next() {
                    if let Some(ext) = first.trim().strip_prefix("*.") {
                        if !ext.is_empty() && ext != "*" && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
                            return Some(to_wide(ext));
                        }
                    }
                }
            }
        }
        None
    }

    pub fn file_dialog(
        save: bool,
        title: Option<&str>,
        filter: Option<&str>,
        default_name: Option<&str>,
        default_dir: Option<&str>,
    ) -> Result<Option<String>, String> {
        let _com = ComGuard::init();
        let mut buffer = vec![0u16; 4096];
        if let Some(name) = default_name.filter(|s| !s.trim().is_empty()) {
            let encoded: Vec<u16> = name.trim().encode_utf16().take(buffer.len() - 1).collect();
            buffer[..encoded.len()].copy_from_slice(&encoded);
        }
        let filter_wide = filter.filter(|s| !s.trim().is_empty()).map(to_filter_wide);
        let title_wide = title.filter(|s| !s.trim().is_empty()).map(to_wide);
        let dir_wide = default_dir
            .filter(|s| !s.trim().is_empty() && Path::new(s).is_dir())
            .map(to_wide);
        let def_ext_wide = if save { default_ext(default_name, filter) } else { None };
        let flags = if save {
            OFN_EXPLORER | OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR
        } else {
            OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR
        };
        let mut ofn = OpenFileNameW {
            l_struct_size: std::mem::size_of::<OpenFileNameW>() as u32,
            hwnd_owner: unsafe { GetForegroundWindow() },
            h_instance: null_mut(),
            lpstr_filter: filter_wide.as_ref().map_or(null(), |v| v.as_ptr()),
            lpstr_custom_filter: null_mut(),
            n_max_cust_filter: 0,
            n_filter_index: 1,
            lpstr_file: buffer.as_mut_ptr(),
            n_max_file: buffer.len() as u32,
            lpstr_file_title: null_mut(),
            n_max_file_title: 0,
            lpstr_initial_dir: dir_wide.as_ref().map_or(null(), |v| v.as_ptr()),
            lpstr_title: title_wide.as_ref().map_or(null(), |v| v.as_ptr()),
            flags,
            n_file_offset: 0,
            n_file_extension: 0,
            lpstr_def_ext: def_ext_wide.as_ref().map_or(null(), |v| v.as_ptr()),
            l_cust_data: 0,
            lpfn_hook: null_mut(),
            lp_template_name: null(),
            pv_reserved: null_mut(),
            dw_reserved: 0,
            flags_ex: 0,
        };
        let ok = unsafe {
            if save { GetSaveFileNameW(&mut ofn) } else { GetOpenFileNameW(&mut ofn) }
        };
        if ok != 0 {
            let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
            let selected = String::from_utf16_lossy(&buffer[..len]).trim().to_string();
            return Ok((!selected.is_empty()).then_some(selected));
        }
        let err = unsafe { CommDlgExtendedError() };
        if err == 0 {
            Ok(None)
        } else {
            Err(format!("打开系统文件窗口失败（错误码 0x{err:x}）"))
        }
    }

    unsafe fn vtable_fn(obj: *mut c_void, index: usize) -> *const c_void {
        let vtable = *(obj as *const *const *const c_void);
        *vtable.add(index)
    }

    unsafe fn release_com(obj: *mut c_void) {
        if obj.is_null() {
            return;
        }
        let func: extern "system" fn(*mut c_void) -> u32 = std::mem::transmute(vtable_fn(obj, 2));
        func(obj);
    }

    pub fn folder_dialog(title: Option<&str>, default_dir: Option<&str>) -> Result<Option<String>, String> {
        let _com = ComGuard::init();
        let mut dialog: *mut c_void = null_mut();
        let hr = unsafe {
            CoCreateInstance(
                &CLSID_FILE_OPEN_DIALOG,
                null_mut(),
                CLSCTX_INPROC_SERVER,
                &IID_IFILE_OPEN_DIALOG,
                &mut dialog,
            )
        };
        if hr != S_OK || dialog.is_null() {
            return Err(format!("无法创建系统文件夹选择窗口（0x{:x}）", hr as u32));
        }
        let outcome = unsafe {
            let get_options: extern "system" fn(*mut c_void, *mut u32) -> HResult =
                std::mem::transmute(vtable_fn(dialog, 10));
            let set_options: extern "system" fn(*mut c_void, u32) -> HResult =
                std::mem::transmute(vtable_fn(dialog, 9));
            let mut opts: u32 = 0;
            if get_options(dialog, &mut opts) == S_OK {
                let _ = set_options(dialog, opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR);
            }
            if let Some(title) = title.filter(|s| !s.trim().is_empty()) {
                let wide = to_wide(title);
                let set_title: extern "system" fn(*mut c_void, *const u16) -> HResult =
                    std::mem::transmute(vtable_fn(dialog, 17));
                let _ = set_title(dialog, wide.as_ptr());
            }
            if let Some(dir) = default_dir.filter(|s| !s.trim().is_empty() && Path::new(s).is_dir()) {
                let wide = to_wide(dir);
                let mut item: *mut c_void = null_mut();
                if SHCreateItemFromParsingName(wide.as_ptr(), null_mut(), &IID_ISHELL_ITEM, &mut item) == S_OK && !item.is_null() {
                    let set_folder: extern "system" fn(*mut c_void, *mut c_void) -> HResult =
                        std::mem::transmute(vtable_fn(dialog, 12));
                    let _ = set_folder(dialog, item);
                    release_com(item);
                }
            }
            let show: extern "system" fn(*mut c_void, *mut c_void) -> HResult =
                std::mem::transmute(vtable_fn(dialog, 3));
            let show_hr = show(dialog, GetForegroundWindow());
            if show_hr == HRESULT_CANCELLED {
                Ok(None)
            } else if show_hr != S_OK {
                Err(format!("打开系统文件夹窗口失败（0x{:x}）", show_hr as u32))
            } else {
                let get_result: extern "system" fn(*mut c_void, *mut *mut c_void) -> HResult =
                    std::mem::transmute(vtable_fn(dialog, 20));
                let mut item: *mut c_void = null_mut();
                if get_result(dialog, &mut item) != S_OK || item.is_null() {
                    Ok(None)
                } else {
                    let get_name: extern "system" fn(*mut c_void, u32, *mut *mut u16) -> HResult =
                        std::mem::transmute(vtable_fn(item, 5));
                    let mut raw: *mut u16 = null_mut();
                    let selected = if get_name(item, SIGDN_FILESYSPATH, &mut raw) == S_OK && !raw.is_null() {
                        let text = from_wide_ptr(raw);
                        CoTaskMemFree(raw as *mut c_void);
                        (!text.trim().is_empty()).then_some(text)
                    } else {
                        None
                    };
                    release_com(item);
                    Ok(selected)
                }
            }
        };
        unsafe { release_com(dialog) };
        outcome
    }

    #[cfg(test)]
    pub(super) fn struct_size() -> usize {
        std::mem::size_of::<OpenFileNameW>()
    }
}

pub fn pick(
    kind: &str,
    title: Option<&str>,
    filter: Option<&str>,
    default_name: Option<&str>,
    default_dir: Option<&str>,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        match kind {
            "dir" | "open_dir" => imp::folder_dialog(title, default_dir),
            "file" | "open_file" => imp::file_dialog(false, title, filter, default_name, default_dir),
            "save_file" => imp::file_dialog(true, title, filter, default_name, default_dir),
            _ => Err("未知选择类型".into()),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (kind, title, filter, default_name, default_dir);
        Err("当前平台不支持原生文件对话框".into())
    }
}

#[cfg(all(test, windows, target_pointer_width = "64"))]
mod tests {
    #[test]
    fn openfilenamew_matches_win64_abi_size() {
        assert_eq!(super::imp::struct_size(), 152);
    }
}
