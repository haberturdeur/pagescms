import { Node, type Editor } from "@tiptap/core";

export type BlockStyle = { name: string; label: string; preview?: Record<string, string> };
// Restrict previews to local presentation; repository config cannot inject global CSS or URLs.
const previewProperties = new Set(["color", "background-color", "border-color", "font-size", "font-weight", "font-style", "text-align", "line-height"]);
export const previewCSS = (preview?: Record<string, string>) => Object.entries(preview || {})
  .filter(([key, value]) => previewProperties.has(key) && typeof value === "string" && /^[#(),.%\w\s-]+$/.test(value))
  .map(([key, value]) => `${key}:${value}`).join(";");
export const validStyleName = /^[a-z][a-z0-9-]*$/;
export const normalizeBlockStyles = (value: unknown): BlockStyle[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((style): style is BlockStyle => {
    if (!style || typeof style.name !== "string" || !validStyleName.test(style.name)
      || typeof style.label !== "string" || !style.label.trim() || seen.has(style.name)) return false;
    seen.add(style.name);
    return true;
  });
};

// Explicit wrappers preserve style identity through Markdown, HTML and visual edits.
export const StyledBlock = Node.create<{ styles: BlockStyle[] }>({
  name: "cmsStyledBlock",
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,
  addOptions() { return { styles: [] }; },
  addAttributes() {
    return { style: {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute("data-cms-style"),
      rendered: false,
    } };
  },
  parseHTML() { return [{ tag: "div[data-cms-style]" }]; },
  renderHTML({ node }) {
    const name = String(node.attrs.style || "");
    const definition = this.options.styles.find(style => style.name === name);
    return ["div", { "data-cms-style": name, "data-style-label": definition?.label || name, class: "cms-styled-block", style: previewCSS(definition?.preview) }, 0];
  },
  markdownTokenizer: {
    name: "cmsStyledBlock",
    level: "block",
    start: (src: string) => src.indexOf('{{< cms-style "'),
    tokenize(src: string, _tokens: unknown[], lexer: any) {
      const opening = /^\{\{< cms-style "([a-z][a-z0-9-]*)" >\}\}\r?\n/.exec(src);
      if (!opening) return undefined;
      // Count wrappers so pasted/nested styles are also lossless.
      const markers = /^\{\{< (cms-style "[a-z][a-z0-9-]*"|\/cms-style) >\}\}[ \t]*\r?$/gm;
      markers.lastIndex = opening[0].length;
      let depth = 1;
      let marker;
      while ((marker = markers.exec(src))) {
        depth += marker[1] === "/cms-style" ? -1 : 1;
        if (depth === 0) {
          const text = src.slice(opening[0].length, marker.index).trim();
          return { type: "cmsStyledBlock", raw: src.slice(0, markers.lastIndex), style: opening[1], tokens: lexer.blockTokens(text) };
        }
      }
      return undefined;
    },
  },
  parseMarkdown(token: any, helpers: any) {
    return helpers.createNode("cmsStyledBlock", { style: token.style }, helpers.parseChildren(token.tokens || []));
  },
  renderMarkdown(node: any, helpers: any) {
    const name = String(node.attrs?.style || "");
    const body = helpers.renderChildren(node.content || [], "\n\n");
    if (!validStyleName.test(name)) return body;
    return `{{< cms-style "${name}" >}}\n\n${body}\n\n{{< /cms-style >}}`;
  },
});

export function applyBlockStyle(editor: Editor, name: string) {
  if (name && !validStyleName.test(name)) return false;
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name !== "cmsStyledBlock") continue;
    const pos = $from.before(depth);
    const tr = name
      ? editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, style: name })
      : editor.state.tr.replaceWith(pos, pos + node.nodeSize, node.content);
    editor.view.dispatch(tr);
    editor.commands.focus();
    return true;
  }
  if (!name) return true;
  // Style the entire table, rather than just the paragraph in the active cell.
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === "table") {
      return editor.chain().focus().setNodeSelection($from.before(depth)).wrapIn("cmsStyledBlock", { style: name }).run();
    }
  }
  return editor.chain().focus().wrapIn("cmsStyledBlock", { style: name }).run();
}
