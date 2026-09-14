import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import ts from 'typescript';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pagescms-style-test-'));
after(() => fs.rmSync(temporary, {recursive: true, force: true}));
const source = fs.readFileSync(new URL('../components/ui/editor/block-styles.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText
  .replace('"@tiptap/core"', JSON.stringify(import.meta.resolve('@tiptap/core')));
const file = path.join(temporary, 'styles.mjs');
fs.writeFileSync(file, code);
const {StyledBlock, normalizeBlockStyles, previewCSS} = await import(pathToFileURL(file));
const manager = new MarkdownManager({extensions: [StarterKit, Table, TableRow, TableHeader, TableCell, StyledBlock]});
const wrap = (name, body) => `{{< cms-style "${name}" >}}\n\n${body}\n\n{{< /cms-style >}}`;
const find = (node, type) => [...(node.type === type ? [node] : []), ...(node.content || []).flatMap(child => find(child, type))];

test('repository-defined styles survive three Markdown saves with content and marks', () => {
  const input = wrap('custom-repo-style', '**A** → B [map](https://example.com/map)') + '\n\n'
    + wrap('another-style', '| Route | Total |\n| --- | --- |\n| A | **12** |');
  const expected = manager.parse(input);
  assert.equal(find(expected, 'cmsStyledBlock').length, 2);
  let output = input;
  for (let i = 0; i < 3; i++) output = manager.serialize(manager.parse(output));
  assert.deepEqual(manager.parse(output), expected);
  assert.equal(find(expected, 'table').length, 1);
});

test('nested and unconfigured style names are preserved', () => {
  const expected = manager.parse(wrap('unknown-style', wrap('nested-style', 'Text')));
  assert.equal(find(expected, 'cmsStyledBlock').length, 2);
  assert.deepEqual(manager.parse(manager.serialize(expected)), expected);
});

test('ordinary Markdown and quotes remain ordinary Markdown', () => {
  const expected = manager.parse('# Heading\n\n> A quote\n\n- One\n- Two');
  assert.equal(find(expected, 'cmsStyledBlock').length, 0);
  assert.deepEqual(manager.parse(manager.serialize(expected)), expected);
});

test('definitions are unique and preview CSS cannot introduce global rules or URLs', () => {
  assert.equal(normalizeBlockStyles([{name:'valid',label:'Valid'}, {name:'valid',label:'Duplicate'}, {name:'../bad',label:'Bad'}]).length, 1);
  assert.equal(previewCSS({'background-image':'url(https://example.com)',color:'red;position:fixed','font-size':'0.8em'}), 'font-size:0.8em');
});
