// Turns an already-loaded pdf.js document into plain data the parser understands.
// Used by BOTH the browser page and the Node eval harness, so they cannot drift apart.
//
// Page model: { index, width, height, items: [{ str, x, y, w, h }] }
// y grows upward from the bottom edge (PDF convention). Rotated pages are not handled.

export async function extractPages(pdfDoc, onProgress) {
  const pages = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const t = it.transform;
      items.push({
        str: it.str.trim().replace(/\s+/g, " "),
        x: t[4],
        y: t[5],
        w: it.width,
        h: Math.hypot(t[2], t[3]) || it.height,
      });
    }
    pages.push({ index: i, width: vp.width, height: vp.height, items });
    if (page.cleanup) page.cleanup();
    if (onProgress) onProgress(i, pdfDoc.numPages);
  }
  return pages;
}
