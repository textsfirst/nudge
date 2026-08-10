import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";

const base = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.6", padding: "8px 0" },
});

/** CodeMirror bound to the app theme (index.css owns the colors). */
export function Editor({
  value,
  onChange,
  language,
  readOnly = false,
}: {
  value: string;
  onChange: (value: string) => void;
  language: "markdown" | "yaml";
  readOnly?: boolean;
}) {
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      theme="none"
      extensions={[base, language === "yaml" ? yaml() : markdown()]}
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: true,
        highlightSelectionMatches: false,
      }}
      className="h-full"
    />
  );
}
