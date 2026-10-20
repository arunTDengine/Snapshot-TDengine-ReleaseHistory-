#!/usr/bin/env python3
"""Desktop GUI for TDengine All-in-One download-center smoke tests."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import tkinter as tk
from datetime import datetime
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from engine import fetch_catalog, plan_checks, run_checks, summarize, support_email_body

APP_TITLE = "TDengine All-in-One Smoketest"
DESKTOP = Path.home() / "Desktop"
BG = "#0f1419"
PANEL = "#171e26"
FG = "#e8eef4"
MUTED = "#8b9aab"
ACCENT = "#20c4b4"
FAIL = "#ef6b6b"
PASS = "#3dd68c"
LINE = "#2a3542"


class App(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title(APP_TITLE)
        self.geometry("1180x760")
        self.minsize(960, 620)
        self.configure(bg=BG)
        self.catalog: dict | None = None
        self.results: list = []
        self._busy = False
        self._build_style()
        self._build()
        self.after(200, self.refresh_catalog)

    def _build_style(self) -> None:
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure(".", background=BG, foreground=FG, fieldbackground=PANEL)
        style.configure("TFrame", background=BG)
        style.configure("Panel.TFrame", background=PANEL)
        style.configure("TLabel", background=BG, foreground=FG, font=("Helvetica", 12))
        style.configure("Muted.TLabel", background=BG, foreground=MUTED, font=("Helvetica", 11))
        style.configure("Panel.TLabel", background=PANEL, foreground=FG, font=("Helvetica", 12))
        style.configure("Title.TLabel", background=BG, foreground=FG, font=("Helvetica", 20, "bold"))
        style.configure("Accent.TLabel", background=BG, foreground=ACCENT, font=("Helvetica", 12))
        style.configure(
            "Run.TButton",
            background=ACCENT,
            foreground="#06211e",
            font=("Helvetica", 13, "bold"),
            padding=(18, 8),
        )
        style.map("Run.TButton", background=[("disabled", "#3a5c58"), ("active", "#2ad4c2")])
        style.configure("TButton", background=PANEL, foreground=FG, padding=(10, 6))
        style.configure("TCheckbutton", background=BG, foreground=FG, font=("Helvetica", 12))
        style.configure(
            "Treeview",
            background=PANEL,
            foreground=FG,
            fieldbackground=PANEL,
            rowheight=26,
            font=("Menlo", 11),
            borderwidth=0,
        )
        style.configure("Treeview.Heading", background="#1e2731", foreground=MUTED, font=("Helvetica", 11, "bold"))
        style.map("Treeview", background=[("selected", "#1f4a45")], foreground=[("selected", FG)])
        style.configure("TProgressbar", troughcolor="#1e2731", background=ACCENT, borderwidth=0)

    def _build(self) -> None:
        pad = ttk.Frame(self)
        pad.pack(fill="both", expand=True, padx=18, pady=16)

        ttk.Label(pad, text=APP_TITLE, style="Title.TLabel").pack(anchor="w")
        ttk.Label(
            pad,
            text="Checks Linux, Windows, and Docker All-in-One artifacts from the live download center.",
            style="Muted.TLabel",
        ).pack(anchor="w", pady=(2, 12))

        info = ttk.Frame(pad)
        info.pack(fill="x")
        self.catalog_var = tk.StringVar(value="Loading catalog from downloads.tdengine.com…")
        ttk.Label(info, textvariable=self.catalog_var, style="Accent.TLabel").pack(side="left")
        ttk.Button(info, text="Refresh catalog", command=self.refresh_catalog).pack(side="right")

        controls = ttk.Frame(pad)
        controls.pack(fill="x", pady=(14, 8))
        self.linux_var = tk.BooleanVar(value=True)
        self.windows_var = tk.BooleanVar(value=True)
        self.docker_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(controls, text="Linux host", variable=self.linux_var).pack(side="left", padx=(0, 14))
        ttk.Checkbutton(controls, text="Windows host", variable=self.windows_var).pack(side="left", padx=(0, 14))
        ttk.Checkbutton(controls, text="Docker", variable=self.docker_var).pack(side="left", padx=(0, 18))
        self.run_btn = ttk.Button(controls, text="Run smoke tests", style="Run.TButton", command=self.start_run)
        self.run_btn.pack(side="left")
        ttk.Button(controls, text="Export report", command=self.export_report).pack(side="right")
        ttk.Button(controls, text="Copy failures", command=self.copy_failures).pack(side="right", padx=(0, 8))

        stats = ttk.Frame(pad)
        stats.pack(fill="x", pady=(4, 8))
        self.stat_vars = {
            "linux": tk.StringVar(value="Linux —"),
            "windows": tk.StringVar(value="Windows —"),
            "docker": tk.StringVar(value="Docker —"),
        }
        for key in ("linux", "windows", "docker"):
            ttk.Label(stats, textvariable=self.stat_vars[key]).pack(side="left", padx=(0, 22))

        self.progress = ttk.Progressbar(pad, mode="determinate")
        self.progress.pack(fill="x", pady=(0, 6))
        self.status_var = tk.StringVar(value="Ready.")
        ttk.Label(pad, textvariable=self.status_var, style="Muted.TLabel").pack(anchor="w", pady=(0, 8))

        columns = ("platform", "component", "artifact", "status", "http", "size", "detail")
        tree_frame = ttk.Frame(pad)
        tree_frame.pack(fill="both", expand=True)
        self.tree = ttk.Treeview(tree_frame, columns=columns, show="headings", selectmode="browse")
        headings = {
            "platform": "Platform",
            "component": "Component",
            "artifact": "Artifact",
            "status": "Status",
            "http": "HTTP",
            "size": "Size",
            "detail": "Detail",
        }
        widths = {
            "platform": 90,
            "component": 110,
            "artifact": 340,
            "status": 80,
            "http": 70,
            "size": 90,
            "detail": 320,
        }
        for col in columns:
            self.tree.heading(col, text=headings[col], anchor="w")
            self.tree.column(col, width=widths[col], anchor="w", stretch=col in {"artifact", "detail"})
        vsb = ttk.Scrollbar(tree_frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        vsb.pack(side="right", fill="y")
        self.tree.tag_configure("fail", foreground=FAIL)
        self.tree.tag_configure("pass", foreground=PASS)

    def platforms(self) -> list[str]:
        selected = []
        if self.linux_var.get():
            selected.append("linux")
        if self.windows_var.get():
            selected.append("windows")
        if self.docker_var.get():
            selected.append("docker")
        return selected

    def refresh_catalog(self) -> None:
        if self._busy:
            return

        def _work() -> None:
            try:
                catalog = fetch_catalog()
                comps = catalog["components"]
                text = (
                    f"Stable {catalog['channel']}  ·  "
                    f"TSDB {comps.get('tsdb')}  ·  IDMP {comps.get('idmp')}  ·  "
                    f"TDgpt {comps.get('tdgpt')}  ·  TDmodel {comps.get('tdmodel')}"
                )
                self.after(0, lambda: self._set_catalog(catalog, text))
            except Exception as exc:  # noqa: BLE001
                self.after(0, lambda: self._catalog_error(str(exc)))

        threading.Thread(target=_work, daemon=True).start()

    def _set_catalog(self, catalog: dict, text: str) -> None:
        self.catalog = catalog
        self.catalog_var.set(text)
        self.status_var.set("Catalog loaded. Press Run smoke tests.")

    def _catalog_error(self, message: str) -> None:
        self.catalog_var.set("Could not load catalog.")
        self.status_var.set(message)
        messagebox.showerror(APP_TITLE, f"Failed to load download-center catalog:\n{message}")

    def start_run(self) -> None:
        if self._busy:
            return
        if not self.catalog:
            self.refresh_catalog()
            messagebox.showinfo(APP_TITLE, "Catalog is still loading. Try again in a moment.")
            return
        platforms = self.platforms()
        if not platforms:
            messagebox.showwarning(APP_TITLE, "Select at least one of Linux, Windows, or Docker.")
            return
        self._busy = True
        self.run_btn.state(["disabled"])
        self.results = []
        for row in self.tree.get_children():
            self.tree.delete(row)
        self.progress["value"] = 0
        self.status_var.set("Planning checks from the live catalog…")
        threading.Thread(target=self._run, args=(platforms,), daemon=True).start()

    def _run(self, platforms: list[str]) -> None:
        try:
            items = plan_checks(self.catalog, platforms)
            total = max(len(items), 1)
            self.after(0, lambda: self._init_progress(len(items)))

            def progress(message: str) -> None:
                self.after(0, lambda: self._tick(message, total))

            results = run_checks(items, progress=progress)
            self.after(0, lambda: self._finish(results))
        except Exception as exc:  # noqa: BLE001
            self.after(0, lambda: self._fail(str(exc)))

    def _init_progress(self, count: int) -> None:
        self.progress["maximum"] = max(count, 1)
        self.progress["value"] = 0
        self.status_var.set(f"Checking {count} artifacts…")

    def _tick(self, message: str, total: int) -> None:
        self.progress["value"] = min(self.progress["value"] + 1, total)
        self.status_var.set(message)

    def _finish(self, results: list) -> None:
        self.results = results
        summary = summarize(results)
        for item in results:
            status = "PASS" if item.ok else "FAIL"
            tag = "pass" if item.ok else "fail"
            self.tree.insert(
                "",
                "end",
                values=(
                    item.platform,
                    item.component,
                    item.name,
                    status,
                    item.http or "",
                    item.size,
                    item.detail,
                ),
                tags=(tag,),
            )
        for key in ("linux", "windows", "docker"):
            slot = summary["platforms"].get(key)
            if slot:
                self.stat_vars[key].set(f"{key.title()}  {slot['pass']}/{slot['total']} pass  {slot['fail']} fail")
            else:
                self.stat_vars[key].set(f"{key.title()} —")
        self.status_var.set(
            f"Done. {summary['passed']} passed, {summary['failed']} failed, {summary['total']} checked."
        )
        self._busy = False
        self.run_btn.state(["!disabled"])
        if summary["failed"]:
            messagebox.showwarning(
                APP_TITLE,
                f"{summary['failed']} artifact(s) failed.\nUse Copy failures to paste into a support email.",
            )

    def _fail(self, message: str) -> None:
        self._busy = False
        self.run_btn.state(["!disabled"])
        self.status_var.set(message)
        messagebox.showerror(APP_TITLE, message)

    def export_report(self) -> None:
        if not self.results or not self.catalog:
            messagebox.showinfo(APP_TITLE, "Run a test first.")
            return
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        default = DESKTOP / f"tdengine-aio-smoketest-{stamp}.json"
        path = filedialog.asksaveasfilename(
            defaultextension=".json",
            initialfile=default.name,
            initialdir=str(DESKTOP),
            filetypes=[("JSON", "*.json"), ("Text", "*.txt")],
        )
        if not path:
            return
        payload = {
            "catalog": self.catalog,
            "summary": summarize(self.results),
            "results": [item.as_dict() for item in self.results],
            "email": support_email_body(self.catalog, self.results),
        }
        Path(path).write_text(json.dumps(payload, indent=2), encoding="utf-8")
        txt = Path(path).with_suffix(".txt")
        txt.write_text(support_email_body(self.catalog, self.results), encoding="utf-8")
        self.status_var.set(f"Saved {path} and {txt.name}")

    def copy_failures(self) -> None:
        if not self.results or not self.catalog:
            messagebox.showinfo(APP_TITLE, "Run a test first.")
            return
        body = support_email_body(self.catalog, self.results)
        self.clipboard_clear()
        self.clipboard_append(body)
        self.status_var.set("Failure report copied to clipboard.")


def main() -> None:
    if sys.platform == "darwin":
        os.environ.setdefault("TK_SILENCE_DEPRECATION", "1")
    app = App()
    app.mainloop()


if __name__ == "__main__":
    main()
