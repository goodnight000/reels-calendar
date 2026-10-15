import { useEffect, useRef, useState } from 'react';
import { EditorContent, Extension, useEditor, useEditorState } from '@tiptap/react';
import { Plugin } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { Placeholder } from '@tiptap/extensions';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Icon, api, countWords, parse, runtime, useAutosize } from './lib.js';

// Every line of a script is its own paragraph. Markdown can't keep stacked line breaks (a line of only
// spaces reads as blank, so they vanish on reload), but empty paragraphs round-trip. So Shift+Enter and
// pasted newlines become paragraph splits. List items keep their breaks; a single one round-trips fine.
const LinesAreParagraphs = Extension.create({
  name: 'linesAreParagraphs',
  addProseMirrorPlugins: () => [new Plugin({
    appendTransaction(trs, _, state) {
      if (!trs.some(t => t.docChanged)) return null;
      const breaks = [];
      state.doc.forEach((block, offset) => {
        if (block.type.name === 'paragraph') block.forEach((n, o) => n.type.name === 'hardBreak' && breaks.push(offset + 1 + o));
      });
      if (!breaks.length) return null;
      const tr = state.tr;
      for (const pos of breaks.reverse()) tr.delete(pos, pos + 1).split(pos);
      return tr;
    },
  })],
});

const extensions = [
  StarterKit.configure({ link: { openOnClick: false } }),
  LinesAreParagraphs,
  TaskList,
  TaskItem.configure({ nested: true }),
  Placeholder.configure({ placeholder: 'Start writing the script…' }),
  Markdown,
];

const TOOLS = [
  { label: 'H1', title: 'Heading', run: c => c.toggleHeading({ level: 1 }), active: e => e.isActive('heading', { level: 1 }) },
  { label: 'H2', title: 'Subheading', run: c => c.toggleHeading({ level: 2 }), active: e => e.isActive('heading', { level: 2 }) },
  { label: 'B', title: 'Bold', cls: 'b', run: c => c.toggleBold(), active: e => e.isActive('bold') },
  { label: 'I', title: 'Italic', cls: 'i', run: c => c.toggleItalic(), active: e => e.isActive('italic') },
  { label: '•', title: 'Bullet list', run: c => c.toggleBulletList(), active: e => e.isActive('bulletList') },
  { label: '1.', title: 'Numbered list', run: c => c.toggleOrderedList(), active: e => e.isActive('orderedList') },
  { label: '☐', title: 'Checklist', run: c => c.toggleTaskList(), active: e => e.isActive('taskList') },
];

function Toolbar({ editor }) {
  // Re-render only when an active state flips, not on every keystroke.
  const active = useEditorState({ editor, selector: ({ editor: e }) => TOOLS.map(t => t.active(e)).join('') });
  return (
    <div className="toolbar" role="toolbar">
      {TOOLS.map((t, i) => (
        <button
          key={t.label}
          title={t.title}
          className={`${t.cls || ''}${active[i] === 't' ? ' on' : ''}`}
          onMouseDown={e => { e.preventDefault(); t.run(editor.chain().focus()).run(); }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function TitleInput({ value, onChange, onEnter, autoFocus }) {
  const ref = useRef(null);
  useAutosize(ref, value);
  return (
    <textarea
      ref={ref}
      autoFocus={autoFocus}
      className="doc-title"
      rows={1}
      value={value}
      placeholder="Untitled video"
      onChange={e => onChange(e.target.value.replace(/\n/g, ''))}
      onKeyDown={e => { if (e.key === 'Enter' || (e.key === 'ArrowDown' && e.currentTarget.selectionEnd === value.length)) { e.preventDefault(); onEnter(); } }}
    />
  );
}

function Doc({ date, id, initial, actions }) {
  const [title, setTitle] = useState(initial.title);
  const [words, setWords] = useState(countWords(initial.body));
  const [status, setStatus] = useState('saved');
  const [saves, setSaves] = useState(0);
  const pending = useRef(null);
  const timer = useRef();
  const titleRef = useRef(initial.title);

  const flush = () => {
    clearTimeout(timer.current);
    if (!pending.current) return;
    const doc = pending.current;
    pending.current = null;
    setStatus('saving');
    api.saveScript(date, id, doc).then(() => { if (!pending.current) { setStatus('saved'); setSaves(n => n + 1); } }, () => setStatus('error'));
  };

  const editor = useEditor({
    extensions,
    content: initial.body,
    contentType: 'markdown',
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    autofocus: initial.title ? 'end' : false,
    editorProps: { attributes: { class: 'prose', spellcheck: 'true' } },
    onUpdate: ({ editor: e }) => schedule(titleRef.current, e.getMarkdown()),
  });

  // Keystrokes only touch refs; React and the calendar hear about it once typing pauses.
  function schedule(nextTitle, body) {
    pending.current = { title: nextTitle, body };
    clearTimeout(timer.current);
    timer.current = setTimeout(commit, 500);
  }

  function commit() {
    if (pending.current) {
      const w = countWords(pending.current.body);
      setWords(w);
      actions.patchScript(date, id, { title: pending.current.title, words: w });
    }
    flush();
  }

  const onTitle = v => {
    setTitle(v);
    titleRef.current = v;
    schedule(v, editor.getMarkdown());
  };

  useEffect(() => {
    const onHide = () => commit();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      // A script closed without a word in it was a misclick; don't leave litter on the calendar.
      if (!titleRef.current.trim() && editor?.isEmpty) {
        clearTimeout(timer.current);
        pending.current = null;
        actions.deleteScript(date, id);
      } else commit();
    };
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  const d = parse(date);
  return (
    <div className="doc-wrap">
      <div className="doc-bar">
        <button className="back" onClick={actions.close}>‹ {d.toLocaleString('en-US', { month: 'short', day: 'numeric' })}</button>
        {editor && <Toolbar editor={editor} />}
        <span className="doc-status">
          {/* Each finished save remounts the check, which replays it. */}
          <span className={`save-mark ${status}${saves ? ' ic-play' : ''}`}>
            {status === 'error' ? <span className="save-dot" /> : <Icon key={saves} name="check" size={14} />}
          </span>
          {status === 'error' ? 'Not saved' : words ? `${words} words · ${runtime(words)}` : status === 'saving' ? 'Saving' : 'Saved'}
        </span>
      </div>
      <article className="page">
        <TitleInput value={title} autoFocus={!initial.title} onChange={onTitle} onEnter={() => editor?.commands.focus('start')} />
        <EditorContent editor={editor} />
      </article>
    </div>
  );
}

export default function Editor({ date, id, initialTitle, actions }) {
  const [initial, setInitial] = useState(null);
  const fallbackTitle = useRef(initialTitle);
  useEffect(() => {
    let live = true;
    api.getScript(date, id).then(doc => live && setInitial({ title: doc.title ?? fallbackTitle.current, body: doc.body ?? '' }));
    return () => { live = false; };
  }, [date, id]);
  if (!initial) return <div className="doc-wrap" />;
  return <Doc date={date} id={id} initial={initial} actions={actions} />;
}
