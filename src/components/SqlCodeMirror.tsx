import { sql } from '@codemirror/lang-sql';
import { Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useMemo } from 'react';

interface SqlCodeMirrorProps {
  ariaLabel?: string;
  className?: string;
  editable?: boolean;
  minHeight?: string;
  onChange?: (value: string) => void;
  onRun?: () => void;
  value: string;
}

export function SqlCodeMirror({ ariaLabel, className, editable = false, minHeight, onChange, onRun, value }: SqlCodeMirrorProps) {
  const extensions = useMemo(
    () => [
      sql(),
      ...(onRun ? [
        Prec.highest(keymap.of([{
          key: 'Mod-Enter',
          run: () => {
            onRun();
            return true;
          },
        }])),
        Prec.highest(EditorView.domEventHandlers({
          keydown: (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              onRun();
              return true;
            }
            return false;
          },
        })),
      ] : []),
      EditorView.theme({
        '&': {
          backgroundColor: 'transparent',
          boxSizing: 'border-box',
          fontSize: 'inherit',
          maxWidth: '100%',
          overflow: 'hidden',
          width: '100%',
        },
        '.cm-content': {
          fontFamily: 'inherit',
          minHeight: minHeight ?? 'auto',
          minWidth: '100%',
          whiteSpace: 'pre',
          width: 'max-content',
        },
        '.cm-gutters': {
          display: 'none',
        },
        '.cm-line': {
          padding: '0',
          whiteSpace: 'pre',
        },
        '.cm-scroller': {
          fontFamily: 'inherit',
          maxWidth: '100%',
          overflow: 'auto',
        },
      }),
      ...(ariaLabel ? [EditorView.contentAttributes.of({ 'aria-label': ariaLabel })] : []),
    ],
    [ariaLabel, minHeight, onRun],
  );

  return (
    <CodeMirror
      aria-label={ariaLabel}
      basicSetup={{
        bracketMatching: true,
        closeBrackets: false,
        foldGutter: false,
        highlightActiveLine: editable,
        highlightActiveLineGutter: false,
        lineNumbers: false,
      }}
      className={className}
      editable={editable}
      extensions={extensions}
      readOnly={!editable}
      value={value}
      onChange={editable ? onChange : undefined}
    />
  );
}
