import { useEffect, useRef, type ReactNode } from "react";

export default function Modal(props: {
  title: string;
  onClose: () => void;
  closeDisabled?: boolean;
  backdropClose?: boolean;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="overlay"
      aria-label={props.title}
      style={{ border: 0, margin: 0, width: "100%", height: "100%", maxWidth: "none", maxHeight: "none", boxSizing: "border-box", color: "inherit" }}
      onCancel={(event) => { event.preventDefault(); if (!props.closeDisabled) props.onClose(); }}
      onClick={(event) => {
        if (event.target === event.currentTarget && props.backdropClose !== false && !props.closeDisabled) {
          props.onClose();
        }
      }}
    >
      <div className="modal">
        <div className="modal-scroll">
          <div className="modal-head">
            <h2>{props.title}</h2>
            <button className="icon-button" disabled={props.closeDisabled} onClick={props.onClose} aria-label="关闭">×</button>
          </div>
          {props.children}
        </div>
      </div>
    </dialog>
  );
}
