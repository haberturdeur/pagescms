# Repository-defined rich-text styles

Rich-text fields can define named block styles in `.pages.yml`:

```yaml
- name: body
  type: rich-text
  options:
    format: markdown
    styles:
      - name: notice
        label: Notice
        preview:
          color: "#555555"
          background-color: "#f5f5f5"
```

Select text and choose a style from **Custom styles** in the existing Text / Heading
menu. Selecting text inside a table applies the style to the entire table.
**Remove custom style** removes the wrapper while retaining its content. Text and
heading commands preserve the wrapper. Styles load with the repository configuration;
adding a definition does not require rebuilding the application.

Names must match `[a-z][a-z0-9-]*` and be unique. Preview CSS is scoped to the styled
block and supports `color`, `background-color`, `border-color`, `font-size`,
`font-weight`, `font-style`, `text-align`, and `line-height`. URLs and arbitrary CSS
rules are not supported. The publishing site supplies the actual rendering and CSS;
preview declarations only affect the editor.

Markdown stores wrappers using Hugo shortcode syntax:

```markdown
{{< cms-style "notice" >}}

Ordinary **Markdown** content.

{{< /cms-style >}}
```

The publishing site must implement the `cms-style` shortcode or an equivalent
processor. HTML mode stores `div[data-cms-style="notice"]` wrappers. Existing style
names survive editing even if their definitions are removed from the menu.

Run preservation and preview validation tests after installing dependencies:

```sh
node --test scripts/test-editor-styles.mjs
```
