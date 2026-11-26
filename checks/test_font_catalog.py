"""Check the generated country/font index and disjoint language archives."""
import zipfile
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

from tools.font_catalog import classify, index_fonts
from tools.prepare_release import archive_tree


def make_font(path: Path, family: str, characters: set[int]) -> None:
    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder([".notdef", "letter"])
    builder.setupCharacterMap({point: "letter" for point in characters})
    glyph = TTGlyphPen(None).glyph()
    builder.setupGlyf({".notdef": glyph, "letter": glyph})
    builder.setupHorizontalMetrics({".notdef": (500, 0), "letter": (600, 0)})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({"familyName": family, "styleName": "Regular",
                            "fullName": family + " Regular", "psName": family.replace(" ", "")})
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    builder.setupPost()
    builder.setupMaxp()
    builder.save(path)


def test_index_covers_every_file_once_and_resolves_family_names(tmp_path):
    source = tmp_path / "fonts"
    source.mkdir()
    latin = set(range(32, 127))
    make_font(source / "arial.ttf", "Arial", latin)
    make_font(source / "msyh.ttf", "Microsoft YaHei", latin | set(range(0x4E00, 0x5300)))
    make_font(source / "Iosevka-Regular.ttf", "Iosevka", latin)
    index = index_fonts(source)
    assert index["families"]["microsoft yahei"] == ["hans"]
    assert index["families"]["arial regular"] == ["base"]
    assert index["families"]["iosevka"] == ["latin-code"]
    assert index["locales"]["en"] == []
    assert index["locales"]["ja"] == ["ja"]
    seen = set()
    for group in ("base", "hans", "latin-code"):
        members = {name for name, entry in index["files"].items() if entry["group"] == group}
        asset = archive_tree(source, tmp_path / f"{group}.zip", members)
        with zipfile.ZipFile(tmp_path / asset["file"]) as archive:
            assert set(archive.namelist()) == members
            assert not seen.intersection(members)
            assert sum(entry.file_size for entry in archive.infolist()) == asset["unpacked_size"]
            seen.update(members)
    assert seen == {path.name for path in source.iterdir()}


def test_ttc_suffix_does_not_misclassify_cjk_as_traditional_chinese():
    # "tc" in a TTC extension must not be mistaken for a regional font hint.
    japanese = set(range(0x4E00, 0x5300)) | set(range(0x3040, 0x3100))
    assert classify("Unknown.ttc", japanese) == "ja"
    assert classify("NotoSansCJKtc-Regular.ttc", japanese) == "hant"
    assert classify("NotoSansCJKsc-Regular.ttc", japanese) == "hans"


def test_font_preview_matches_repeated_draw_without_changing_identity():
    from core.identity import create_identity
    from core.launcher import required_font_families
    import copy
    identity = create_identity(name="Font check", os="macos", country="JP")
    original = copy.deepcopy(identity.to_dict())
    first = required_font_families(identity)
    assert first
    assert required_font_families(identity) == first
    assert identity.to_dict() == original


def test_font_preview_accepts_subscription_proxy_without_starting_core():
    # Subscription identities have no proxy_server until launch starts mihomo.
    # The read-only preview must still resolve fonts instead of demanding one.
    from core.identity import create_identity
    from core.launcher import required_font_families
    identity = create_identity(
        name="Font proxy check", os="macos", country="JP",
        network_mode="proxy", proxy_source="demo.yaml", proxy_node="node-a")
    assert required_font_families(identity)
