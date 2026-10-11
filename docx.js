// Minimal .docx writer: turns a list of blocks into a Word file (Uint8Array).
//
//   blocks: [{ style: "Title" | "Heading1" | "Heading2" | "Normal" | "Bullet",
//              runs: [{ text, bold, italic, color, link, br }] }]
//
// A .docx is a zip of a few XML parts; files are stored uncompressed, which keeps the
// writer tiny and is valid for Word, Google Docs and LibreOffice.

const DOCX = (() => {
  const enc = new TextEncoder();
  const xml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

  // --- zip (store only) ---------------------------------------------------------------

  const CRC = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zip(files) {
    const parts = [], central = [];
    let offset = 0;
    for (const [name, text] of files) {
      const nameBytes = enc.encode(name), data = enc.encode(text), crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(8, 0, true);             // method: store
      local.setUint16(12, 0x21, true);         // date: 1980-01-01
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      parts.push(new Uint8Array(local.buffer), nameBytes, data);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(14, 0x21, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, nameBytes.length, true);
      cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const cenSize = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    for (const p of all) { out.set(p, pos); pos += p.length; }
    return out;
  }

  // --- document -----------------------------------------------------------------------

  const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const heading = (id, name, size, before) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>` +
    `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="120"/>` +
    `<w:outlineLvl w:val="${id === "Title" ? 0 : Number(id.slice(-1)) - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;

  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${heading("Title", "Title", 44, 0)}
${heading("Heading1", "heading 1", 32, 360)}
${heading("Heading2", "heading 2", 26, 240)}
<w:style w:type="paragraph" w:styleId="Bullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:after="60"/><w:ind w:left="360" w:hanging="360"/></w:pPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1155CC"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>`;

  function build(blocks) {
    const links = [];
    const run = (r) => {
      const props = (r.bold ? "<w:b/>" : "") + (r.italic ? "<w:i/>" : "") + (r.color ? `<w:color w:val="${r.color}"/>` : "");
      const body = (r.br ? "<w:br/>" : "") + (r.text ? `<w:t xml:space="preserve">${xml(r.text)}</w:t>` : "");
      if (r.link) {
        links.push(r.link);
        return `<w:hyperlink r:id="rLink${links.length}"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/>${props}</w:rPr>${body}</w:r></w:hyperlink>`;
      }
      return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${body}</w:r>`;
    };
    const paras = blocks.map((b) => {
      const runs = b.style === "Bullet" ? [{ text: "•\t" }, ...b.runs] : b.runs;
      return `<w:p><w:pPr><w:pStyle w:val="${b.style || "Normal"}"/></w:pPr>${runs.map(run).join("")}</w:p>`;
    }).join("");

    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>${paras}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body>
</w:document>`;

    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${links.map((l, i) => `<Relationship Id="rLink${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(l)}" TargetMode="External"/>`).join("\n")}
</Relationships>`;

    return zip([
      ["[Content_Types].xml", CONTENT_TYPES],
      ["_rels/.rels", ROOT_RELS],
      ["word/document.xml", document],
      ["word/_rels/document.xml.rels", docRels],
      ["word/styles.xml", STYLES],
    ]);
  }

  const MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  // data: URL, because service workers can't make blob: URLs for chrome.downloads.
  function dataUrl(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${MIME};base64,` + btoa(bin);
  }

  return { build, dataUrl, MIME };
})();
