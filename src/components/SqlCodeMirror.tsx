import { sql } from '@codemirror/lang-sql';
import { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useMemo } from 'react';

interface SqlCodeMirrorProps {
  ariaLabel?: string;
  className?: string;
  editable?: boolean;
  minHeight?: string;
  onChange?: (value: string) => void;
  value: string;
}

export function SqlCodeMirror({ ariaLabel, className, editable = false, minHeight, onChange, value }: SqlCodeMirrorProps) {
  const extensions = useMemo(
    () => [
      sql(),
      EditorView.theme({
        '&': {
          backgroundColor: 'transparent',
          fontSize: 'inherit',
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
          overflow: 'auto',
        },
      }),
      ...(ariaLabel ? [EditorView.contentAttributes.of({ 'aria-label': ariaLabel })] : []),
    ],
    [ariaLabel, minHeight],
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
