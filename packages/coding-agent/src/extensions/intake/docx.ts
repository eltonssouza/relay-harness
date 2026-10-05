/**
 * Minimal Word (.docx) writer: paragraphs, headings and bordered tables in a ZIP package. It covers
 * what an intake questionnaire needs, so Relay ships no document library.
 */

import { crc32, deflateRawSync } from "node:zlib";

export interface DocxRun {
	text: string;
	bold?: boolean;
	italic?: boolean;
	/** Hex color without `#`. */
	color?: string;
}

export type DocxParagraphStyle = "Title" | "Subtitle" | "Heading1" | "Heading2" | "Normal" | "Hint" | "Callout";

export interface DocxParagraph {
	type: "paragraph";
	style?: DocxParagraphStyle;
	runs: DocxRun[];
	/** Left indent in twentieths of a point. */
	indent?: number;
	keepWithNext?: boolean;
}

export interface DocxTable {
	type: "table";
	/** Header cells, shaded and bold. */
	header?: string[];
	/** Body rows; each cell holds plain text. */
	rows: string[][];
	/** Minimum height of each body row in twentieths of a point. */
	rowHeight?: number;
}

export type DocxBlock = DocxParagraph | DocxTable;

export interface DocxDocument {
	title: string;
	language: string;
	blocks: DocxBlock[];
}

/** Text content of a run or table cell: characters XML 1.0 cannot hold are dropped. */
function escapeXml(text: string): string {
	const allowed = (code: number) =>
		code === 0x9 ||
		code === 0xa ||
		code === 0xd ||
		(code >= 0x20 && code <= 0xd7ff) ||
		(code >= 0xe000 && code <= 0xfffd) ||
		code >= 0x10000;
	return Array.from(text)
		.filter((char) => allowed(char.codePointAt(0) ?? 0))
		.join("")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function renderRun(run: DocxRun): string {
	const props = [
		run.bold ? "<w:b/>" : "",
		run.italic ? "<w:i/>" : "",
		run.color ? `<w:color w:val="${run.color}"/>` : "",
	].join("");
	// Line breaks inside a run become <w:br/>.
	const parts = run.text.split(/\r?\n/).map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`);
	return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${parts.join("<w:br/>")}</w:r>`;
}

function renderParagraph(paragraph: DocxParagraph): string {
	const props = [
		paragraph.style && paragraph.style !== "Normal" ? `<w:pStyle w:val="${paragraph.style}"/>` : "",
		paragraph.keepWithNext ? "<w:keepNext/>" : "",
		paragraph.indent ? `<w:ind w:left="${paragraph.indent}"/>` : "",
	].join("");
	return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${paragraph.runs.map(renderRun).join("")}</w:p>`;
}

const BORDER =
	'<w:top w:val="single" w:sz="8" w:color="7F7F7F"/><w:left w:val="single" w:sz="8" w:color="7F7F7F"/><w:bottom w:val="single" w:sz="8" w:color="7F7F7F"/><w:right w:val="single" w:sz="8" w:color="7F7F7F"/><w:insideH w:val="single" w:sz="8" w:color="7F7F7F"/><w:insideV w:val="single" w:sz="8" w:color="7F7F7F"/>';
/** Usable width of an A4 page with 2 cm margins, in twentieths of a point. */
const TEXT_WIDTH = 9638;

function renderCell(text: string, width: number, header: boolean): string {
	const shading = header ? '<w:shd w:val="clear" w:color="auto" w:fill="DCE6F2"/>' : "";
	const lines = text === "" ? [""] : text.split(/\r?\n/);
	const paragraphs = lines.map((line) => renderParagraph({ type: "paragraph", runs: [{ text: line, bold: header }] }));
	return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shading}</w:tcPr>${paragraphs.join("")}</w:tc>`;
}

function renderTable(table: DocxTable): string {
	const columns = Math.max(table.header?.length ?? 0, ...table.rows.map((row) => row.length), 1);
	const width = Math.floor(TEXT_WIDTH / columns);
	const pad = (row: string[]) => [...row, ...Array<string>(columns - row.length).fill("")];
	const grid = `<w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(columns)}</w:tblGrid>`;
	const height = table.rowHeight ? `<w:trPr><w:trHeight w:val="${table.rowHeight}" w:hRule="atLeast"/></w:trPr>` : "";
	const header = table.header
		? `<w:tr><w:trPr><w:tblHeader/></w:trPr>${pad(table.header)
				.map((cell) => renderCell(cell, width, true))
				.join("")}</w:tr>`
		: "";
	const rows = table.rows
		.map(
			(row) =>
				`<w:tr>${height}${pad(row)
					.map((cell) => renderCell(cell, width, false))
					.join("")}</w:tr>`,
		)
		.join("");
	// An empty paragraph after the table keeps consecutive tables apart.
	return `<w:tbl><w:tblPr><w:tblW w:w="${width * columns}" w:type="dxa"/><w:tblBorders>${BORDER}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>${grid}${header}${rows}</w:tbl><w:p/>`;
}

const NAMESPACES =
	'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function documentXml(document: DocxDocument): string {
	const body = document.blocks
		.map((block) => (block.type === "table" ? renderTable(block) : renderParagraph(block)))
		.join("");
	const section =
		'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>';
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NAMESPACES}><w:body>${body}${section}</w:body></w:document>`;
}

function style(id: string, name: string, paragraph: string, run: string): string {
	return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr>${paragraph}</w:pPr><w:rPr>${run}</w:rPr></w:style>`;
}

function stylesXml(language: string): string {
	const lang = escapeXml(language);
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${NAMESPACES}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="${lang}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${style(
		"Title",
		"Title",
		'<w:spacing w:after="240"/>',
		'<w:b/><w:color w:val="1F3864"/><w:sz w:val="44"/><w:szCs w:val="44"/>',
	)}${style("Subtitle", "Subtitle", '<w:spacing w:after="200"/>', '<w:color w:val="595959"/><w:sz w:val="26"/>')}${style(
		"Heading1",
		"heading 1",
		'<w:keepNext/><w:spacing w:before="360" w:after="160"/><w:outlineLvl w:val="0"/>',
		'<w:b/><w:color w:val="1F3864"/><w:sz w:val="32"/><w:szCs w:val="32"/>',
	)}${style(
		"Heading2",
		"heading 2",
		'<w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/>',
		'<w:b/><w:color w:val="2F5496"/><w:sz w:val="26"/><w:szCs w:val="26"/>',
	)}${style("Hint", "Hint", "", '<w:i/><w:color w:val="595959"/><w:sz w:val="22"/>')}${style(
		"Callout",
		"Callout",
		'<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:ind w:left="170" w:right="170"/>',
		'<w:sz w:val="22"/>',
	)}</w:styles>`;
}

function coreXml(title: string, language: string): string {
	const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:language>${escapeXml(language)}</dc:language><dc:creator>relay /intake</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

/** Deflated ZIP archive with UTF-8 names, as the Office Open XML package format requires. */
export function zip(files: ReadonlyArray<{ name: string; data: Buffer }>): Buffer {
	const local: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const name = Buffer.from(file.name, "utf8");
		const compressed = deflateRawSync(file.data);
		const crc = crc32(file.data);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4); // version needed
		header.writeUInt16LE(0x0800, 6); // UTF-8 names
		header.writeUInt16LE(8, 8); // deflate
		header.writeUInt16LE(0, 10); // time
		header.writeUInt16LE(0x21, 12); // date: 1980-01-01
		header.writeUInt32LE(crc, 14);
		header.writeUInt32LE(compressed.length, 18);
		header.writeUInt32LE(file.data.length, 22);
		header.writeUInt16LE(name.length, 26);
		header.writeUInt16LE(0, 28);
		local.push(header, name, compressed);

		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4); // version made by
		entry.writeUInt16LE(20, 6);
		entry.writeUInt16LE(0x0800, 8);
		entry.writeUInt16LE(8, 10);
		entry.writeUInt16LE(0, 12);
		entry.writeUInt16LE(0x21, 14);
		entry.writeUInt32LE(crc, 16);
		entry.writeUInt32LE(compressed.length, 20);
		entry.writeUInt32LE(file.data.length, 24);
		entry.writeUInt16LE(name.length, 28);
		entry.writeUInt32LE(offset, 42);
		central.push(entry, name);
		offset += header.length + name.length + compressed.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
}

export function renderDocx(document: DocxDocument): Buffer {
	const file = (name: string, text: string) => ({ name, data: Buffer.from(text, "utf8") });
	return zip([
		file("[Content_Types].xml", CONTENT_TYPES),
		file("_rels/.rels", PACKAGE_RELS),
		file("word/document.xml", documentXml(document)),
		file("word/_rels/document.xml.rels", DOCUMENT_RELS),
		file("word/styles.xml", stylesXml(document.language)),
		file("docProps/core.xml", coreXml(document.title, document.language)),
	]);
}
