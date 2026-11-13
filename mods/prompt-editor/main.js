// Prompt Editor (herdr-prompt-editor): a real editor for coding-agent prompts for coding agents, docked under each pane.
//
// Layout: make it the pane header, at the bottom (or the top — it opens downwards then):
//   "pane": { "header": { "content": { "mod": "prompt-editor" }, "height": 32, "position": "bottom" } }
// The bar is Herdr's own pane header (icon, name, folder, status, buttons on hover).
//
// The editor opens through the agent's own "edit prompt in $VISUAL" key (ctrl-g in
// Claude Code, Codex and pi): with $VISUAL pointing at editor.sh (next to this
// file), the agent hands over what is already typed and the editor slides up out
// of that pane's bar with it. See README.md.
//
// In a layout without it, editor.sh opens it as a dialog instead
// (`mod.open prompt-editor`), for the terminal named in data/prompt-editor/pending.
//   enter        put the text back and submit it
//   shift-enter  new line
//   esc          put the text back without submitting
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Popup } from "gpui-base";
import { run, notify, props, closeOverlay, theme, settings, panes, home, appHome, nextCommand, readTextFile, writeTextFile, shared, setShared, layout } from "herdr";

// The first visible tab frame, including the active child of a stack (as Herdr's `pane` mod).
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter((child) => !child.hidden);
    children = [visible.find((child) => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

// Docked at the pane's bottom (opens upwards), unless the layout put the header on top.
const atBottom = () => paneFrame(layout())?.header?.position !== "top";

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function agentName(p) {
  return (p && (((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name)) || "the agent";
}

export default class PromptEditor extends View {
  init(_props, cx) {
    // init's cx is an AsyncContext: it may be held across await, unlike a handler's.
    this.acx = cx;
    // A dialog (no pane of its own) or a pane header.
    this.floating = Boolean(props()?.overlay) && !props()?.pane;
    this.term = this.floating ? null : props()?.terminal;
    this.hovered = false;
    this.width = 0;
    this.fade = 1;
    this.focused = false;
    // Dragged height of the text area in px (null: grow with the text), kept across restarts.
    this.height = shared("prompt-editor.height") ?? null;
    this.drag = null; // { y, height } while the top edge is being dragged
    this.request = null; // { file, original } while an agent waits on us

    this.state = TextareaState.new({ placeholder: "Describe what you want…" });
    this.state.set_auto_grow(12, 28);
    this.state.set_soft_wrap(true);
    this.cur = this.prev = "";
    this.state.on("change", (_e, cx) => { this.prev = this.cur; this.cur = this.state.value(); cx.notify(); });
    this.state.on("focus", (_e, cx) => { this.focused = true; cx.notify(); });
    this.state.on("blur", (_e, cx) => { this.focused = false; cx.notify(); });
    // Fires after the textarea has already inserted the newline for Enter.
    this.state.on("submit", (e) => {
      if (e.shift || e.secondary) return;
      const text = this.cur.length === this.prev.length + 1 ? this.prev : this.cur;
      this.finish(text, true);
    });
    this.handle = cx.focus_handle();

    if (this.floating) {
      cx.spawn(async (cx) => {
        this.term = (await readTextFile(`${appHome()}/data/prompt-editor/pending`))?.trim() || null;
        await this.pickUp(cx);
        if (!this.request) closeOverlay(props().overlay);
      });
    } else {
      cx.spawn(async (cx) => {
        for (;;) {
          const c = await nextCommand();
          if (c === "open") await this.pickUp(cx);
        }
      });
    }
  }

  // Esc closes a dialog before our key handler sees it: give the text back.
  async close() {
    if (this.request) await this.handBack(this.request, this.cur, false);
  }

  me() {
    return this.floating
      ? panes().find((p) => p.terminal === this.term)
      : panes().find((p) => p.pane === props()?.pane);
  }

  spool(ext) {
    return `${appHome()}/data/prompt-editor/${this.term}.${ext}`;
  }

  // editor.sh left `<terminal>.req` (the agent's temp file) for the pane it runs in.
  async pickUp(cx) {
    // PROMPT_EDITOR_DEBUG=1 in editor.sh leaves debug.log; then every copy reports in.
    if ((await readTextFile(`${appHome()}/data/prompt-editor/debug.log`)) !== null) {
      notify({ title: "prompt-editor: open", body: `pane ${props()?.pane} terminal ${this.term} floating ${this.floating} busy ${Boolean(this.request)}`, timeout: 8000 });
    }
    if (this.request || !this.term) return;
    const req = await readTextFile(this.spool("req"));
    if (!req) return;
    const file = req.trim();
    const original = (await readTextFile(file)) ?? "";
    this.request = { file, original };
    this.state.set_value(original.replace(/\n+$/, ""));
    this.cur = this.prev = this.state.value();
    const end = this.cur.length;
    this.state.set_selected_range({ start: end, end });
    this.state.focus();
    // Fade in over ~120 ms.
    for (this.fade = 0.2; this.fade < 1; this.fade = Math.min(1, this.fade + 0.2)) {
      cx.notify();
      await cx.sleep(24);
    }
    cx.notify();
  }

  // Called from key handlers, whose cx dies with the call: the work runs on init's.
  finish(text, submit) {
    const r = this.request;
    if (!r) return;
    this.acx.spawn(() => this.handBack(r, text, submit));
  }

  // Writes the text into the agent's file and tells editor.sh, which hands it
  // back to the agent (and presses Enter for it when `submit`).
  async handBack(r, text, submit) {
    if (this.request !== r) return;
    this.request = null;
    this.state.set_value("");
    this.cur = this.prev = "";
    const pane = this.me()?.pane, done = this.spool("done");
    try {
      try {
        await writeTextFile(r.file, text, r.original);
      } catch {
        await writeTextFile(r.file, text, await readTextFile(r.file));
      }
      await writeTextFile(done, submit ? "submit" : "keep", await readTextFile(done));
    } catch (err) {
      notify({ title: "Prompt Editor", body: String(err), level: "error" });
    }
    if (pane) run("pane.focus", { pane });
    if (this.floating) closeOverlay(props().overlay);
    else this.acx.notify();
  }

  key(e, cx) {
    if (e.key === "escape") {
      this.finish(this.cur, false);
      cx.stop_propagation();
    }
  }

  button(t, id, name, command, args) {
    return div().id(id).p(3).rounded(4).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); run(command, args); })
      .child(svg(`mods/pane/${name}.svg`).size(14));
  }

  // Herdr's shipped `pane` header, at the bottom.
  bar(t) {
    const p = this.me();
    if (!p) return div().size_full();
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    return h_flex().id(`pe-head-${pane}`).size_full().px(10).gap(8).items_center()
      .bg(t.background).when(atBottom(), (el) => el.border_t(1)).when(!atBottom(), (el) => el.border_b(1))
      .border_color(t.border).text_size(12)
      .on_size_change((size, cx) => {
        const w = size.width / (settings().zoom ?? 1);
        if (Math.abs(w - this.width) > 0.5) { this.width = w; cx.notify(); }
      })
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(agentName(p)))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(Boolean(this.request), (el) => el.child(div().flex_none().text_color(t.accent).child("Writing a prompt…")))
      .when(st === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", (el) => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, (el) => el
        .child(this.button(t, `ch-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ch-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ch-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ch-x-${pane}`, "close", "pane.close", { pane })));
  }

  // The card's top edge: a grabber; drag to resize, double-click to grow with the text again.
  grip(t) {
    const zoom = settings().zoom ?? 1;
    const up = atBottom(); // the free edge: top when docked at the bottom
    const move = (e, cx) => {
      if (!this.drag) return;
      const h = this.drag.height + (up ? this.drag.y - e.position.y : e.position.y - this.drag.y) / zoom;
      this.height = Math.max(60, Math.min(h, 1400));
      cx.notify();
    };
    const end = (_e, cx) => {
      if (!this.drag) return;
      this.drag = null;
      setShared("prompt-editor.height", this.height);
      cx.notify();
    };
    return h_flex().id("pe-grip").absolute().when(up, (el) => el.top(0)).when(!up, (el) => el.bottom(0)).left(0).right(0).h(12)
      .justify_center().items_center().cursor_row_resize()
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        if (e.click_count === 2) {
          this.height = null;
          setShared("prompt-editor.height", null);
        } else {
          this.drag = { y: e.position.y, height: this.height ?? this.textHeight ?? 240 };
        }
        cx.notify();
      })
      .on_mouse_move(move).on_mouse_up("left", end)
      .child(div().w(36).h(4).rounded(2).bg(this.drag ? t.accent : t.border))
      // While dragging, a tall invisible catcher keeps the pointer "on" the grip.
      .when(Boolean(this.drag), (el) => el.child(
        div().id("pe-catch").absolute().top(-2000).left(-2000).w(8000).h(4000)
          .on_mouse_move(move).on_mouse_up("left", end)));
  }

  keycap(t, label) {
    return div().flex_none().min_w(20).h(20).px(6).flex().items_center().justify_center()
      .rounded(5).border_1().border_color(t.border).bg(t.raised)
      .text_size(11).font_medium().text_color(t.foreground).child(label);
  }

  hint(t, keys, what) {
    return h_flex().gap(4).items_center()
      .children(keys.map((k) => this.keycap(t, k)))
      .child(div().pl(2).text_size(11.5).text_color(t.muted).child(what));
  }

  editor(t) {
    const p = this.me();
    const name = agentName(p);
    const pic = icon(p?.program, 15, t.dim);
    const lines = this.cur ? this.cur.split("\n").length : 0;
    const area = Textarea.new(this.state).w_full().text_size(14).line_height(1.6).text_color(t.foreground);

    const header = h_flex().px(16).pt(16).pb(2).gap(8).items_center().text_size(12)
      .child(div().flex_none().size(8).rounded(4).bg(t.accent))
      .child(div().flex_none().font_semibold().text_color(t.foreground).child("Prompt"))
      .child(div().flex_none().text_color(t.dim).child("for"))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().font_medium().text_color(t.foreground).child(name))
      .when(Boolean(p?.cwd), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(folder(p.cwd))))
      .when(!p?.cwd, (el) => el.child(div().flex_1()))
      .when(Boolean(p?.branch), (el) => el.child(div().flex_none().px(7).h(20).flex().items_center().rounded(10)
        .bg(t.raised).text_size(11).text_color(t.muted).child(p.branch)))
      .when(lines > 0, (el) => el.child(div().flex_none().pl(4).text_size(11).text_color(t.dim)
        .child(`${lines} ${lines === 1 ? "line" : "lines"} · ${this.cur.length} chars`)));

    const footer = h_flex().px(14).py(9).gap(16).items_center()
      .border_t_1().border_color(t.border).bg(t.surface).rounded_b(12)
      .child(this.hint(t, ["↩"], "Send"))
      .child(this.hint(t, ["⇧", "↩"], "New line"))
      .child(this.hint(t, ["esc"], `Back to ${name}`))
      .child(div().flex_1())
      .when(!this.floating, (el) => el.child(div().text_size(11).text_color(t.dim)
        .child(this.height ? "Double-click the edge to auto-size" : "Drag the edge to resize")));

    const card = v_flex().id("pe-card").relative().w_full().rounded(12).bg(t.popover)
      .when(!this.floating, (el) => el.border_1().border_color(this.focused ? t.accent : t.border).shadow_xl())
      .opacity(this.fade)
      .child(header)
      .child(div().id("pe-text").px(16).pt(8).pb(12).font_family(settings().font_family ?? "JetBrains Mono")
        .on_size_change((size) => { if (!this.drag) this.textHeight = size.height / (settings().zoom ?? 1) - 20; })
        .child(this.height ? area.h(this.height) : area))
      .child(footer)
      .when(!this.floating, (el) => el.child(this.grip(t)));

    const root = v_flex().id("pe-editor").track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    if (this.floating) return root.w_full().child(card);
    return root.w(this.width).px(8).when(atBottom(), (el) => el.pb(8)).when(!atBottom(), (el) => el.pt(8))
      .child(card);
  }

  render() {
    const t = theme();
    if (this.floating) return this.request ? this.editor(t) : div();
    return Popup.new(`pe-${props()?.pane}`, this.bar(t)).anchor(atBottom() ? "bottom_left" : "top_left").size_full()
      .when(Boolean(this.request) && this.width > 0, (el) => el.content(this.editor(t)));
  }
}
