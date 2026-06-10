import { memo } from 'react';

interface HTMLRendererProps {
  height?: string;
  htmlContent: string;
  width?: string;
}
// Raw model-generated HTML, no DOMPurify: scripts must run for interactive
// artifacts. Isolation comes from the sandbox attribute — without
// allow-same-origin the document gets an opaque origin, so it cannot read
// cookies/storage or call our API with the user's session.
const HTMLRenderer = memo<HTMLRendererProps>(({ htmlContent, width = '100%', height = '100%' }) => {
  return (
    <iframe
      sandbox="allow-scripts allow-forms allow-modals allow-popups"
      srcDoc={htmlContent}
      style={{ border: 'none', height, width }}
      title="html-renderer"
    />
  );
});

export default HTMLRenderer;
