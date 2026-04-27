import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import './MarkdownPreview.css';

interface MarkdownPreviewProps {
  content: string;
}

export default function MarkdownPreview({ content }: MarkdownPreviewProps) {
  const [html, setHtml] = useState<string>('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await marked.parse(content, { async: true, gfm: true, breaks: false });
        if (!cancelled) setHtml(result);
      } catch {
        if (!cancelled) setHtml('');
      }
    })();
    return () => { cancelled = true; };
  }, [content]);

  return (
    <div className="md-preview-pane" role="region" aria-label="Markdown preview">
      <div
        ref={scrollRef}
        className="md-preview-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
