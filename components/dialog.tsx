"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

export function Dialog({ title, children, close, drawer = false }: {
  title: string; children: React.ReactNode; close: () => void; drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className={drawer ? "drawer" : "modal"} aria-labelledby="dialog-title"
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="dialog-content">
      <div className="dialog-header"><h2 id="dialog-title">{title}</h2>
        <button className="icon-button" aria-label={`Close ${title.toLowerCase()}`} onClick={close}><X size={20}/></button>
      </div>
      {children}
    </div>
  </dialog>;
}
