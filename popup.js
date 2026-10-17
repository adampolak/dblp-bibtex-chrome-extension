const REMOVE = new Set(["editor", "timestamp", "biburl", "bibsource"]);

function readFields(source, start, close) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let fieldStart = start;

  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") { i++; continue; }

    if (depth === 0 && !quoted) {
      if (c === close) {
        parts.push(source.slice(fieldStart, i));
        return { parts, end: i + 1 };
      }
      if (c === ",") {
        parts.push(source.slice(fieldStart, i));
        fieldStart = i + 1;
        continue;
      }
    }

    if (c === "{") depth++;
    else if (c === "}") {
      if (--depth < 0) throw new Error("Unbalanced braces in BibTeX.");
    } else if (c === '"' && depth === 0) quoted = !quoted;
  }
  throw new Error("The BibTeX entry is incomplete or has unbalanced braces/quotes.");
}

function cleanBibtex(source) {
  if (typeof source !== "string") throw new TypeError("BibTeX must be text.");
  source = source.replace(/\r\n?/g, "\n").trim();
  const entries = [];
  let pos = 0;

  while (pos < source.length) {
    const header = /^@([A-Za-z]+)\s*([({])\s*([^,\s{}()]+)\s*,/.exec(source.slice(pos));
    if (!header || /^(comment|string|preamble)$/i.test(header[1])) {
      throw new Error("Expected an ordinary BibTeX record from dblp.");
    }

    const [, type, open, key] = header;
    const close = open === "{" ? "}" : ")";
    const { parts, end } = readFields(source, pos + header[0].length, close);
    const fields = parts.map(part => part.trim()).filter(Boolean).map(raw => {
      const match = /^([A-Za-z][\w-]*)\s*=\s*([\s\S]+)$/.exec(raw);
      if (!match) throw new Error("Could not parse a BibTeX field.");
      const name = match[1].toLowerCase();
      if (name === "title" || name === "booktitle") {
        raw = raw.replace(/\s*\n\s*/g, " ");
      }
      return { name, raw };
    });

    const hasDoi = fields.some(field => field.name === "doi");
    const kept = fields.filter(field =>
      !REMOVE.has(field.name) && !(hasDoi && field.name === "url")
    );
    const shortKey = key.slice(key.lastIndexOf("/") + 1);
    if (!shortKey) throw new Error("The BibTeX citation key is empty.");
    const body = kept.map(field => `  ${field.raw}`).join(",\n");
    entries.push(`@${type}${open}${shortKey},\n${body ? body + "\n" : ""}${close}`);

    pos = end;
    while (/\s/.test(source[pos] ?? "") && pos < source.length) pos++;
  }

  if (!entries.length) throw new Error("No BibTeX record was found.");
  return entries.join("\n\n") + "\n";
}

/** Locate literal booktitle contents without reformatting the surrounding text. */
export function findBooktitles(source) {
  const result = [];
  const header = /\s*@([A-Za-z]+)\s*([({])\s*([^,\s{}()]+)\s*,/y;
  let pos = 0;
  while (source.slice(pos).trim()) {
    header.lastIndex = pos;
    const entry = header.exec(source);
    if (!entry || /^(comment|string|preamble)$/i.test(entry[1])) {
      throw new Error("Expected an ordinary BibTeX record from dblp.");
    }
    let offset = header.lastIndex;
    const { parts, end } = readFields(source, offset, entry[2] === "{" ? "}" : ")");
    for (const raw of parts) {
      const prefix = /^\s*booktitle\s*=\s*/i.exec(raw);
      if (prefix) {
        const literal = raw.slice(prefix[0].length).trimEnd();
        const open = literal[0];
        // Only edit a single literal, never a macro or a # concatenation.
        if (open === "{" || open === '"') {
          let depth = open === "{" ? 1 : 0;
          for (let i = 1; i < literal.length; i++) {
            const c = literal[i];
            if (c === "\\") { i++; continue; }
            if (c === "{") depth++;
            else if (c === "}") depth--;
            if ((open === "{" && c === "}" && depth === 0) ||
                (open === '"' && c === '"' && depth === 0)) {
              if (i === literal.length - 1) {
                const start = offset + prefix[0].length + 1;
                result.push({ key: entry[3], start, end: start + i - 1,
                  value: literal.slice(1, i) });
              }
              break;
            }
          }
        }
      }
      offset += raw.length + 1;
    }
    pos = end;
  }
  return result;
}

const textarea = document.querySelector("#bibtex");
const copyButton = document.querySelector("#copy");
const status = document.querySelector("#status");
const booktitleControls = document.querySelector("#booktitles");

let booktitles = [];

function message(text, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}

function refreshBooktitles() {
  let fields;
  try {
    fields = findBooktitles(textarea.value);
  } catch {
    // Incomplete manual edits are allowed; do not offer stale controls.
    booktitleControls.hidden = true;
    return;
  }
  booktitles = fields.map((field, i) => ({
    ...field,
    // Keep deselected parts after edits elsewhere; rebuild a manually edited booktitle.
    parts: booktitles[i]?.value === field.value ? booktitles[i].parts :
      field.value.split(",").map(text => ({ text: text.trim(), included: true }))
  }));
  booktitleControls.replaceChildren();
  booktitleControls.hidden = booktitles.length === 0;

  for (const field of booktitles) {
    const group = document.createElement("fieldset");
    // const legend = document.createElement("legend");
    // legend.textContent = `Toggle parts to include in booktitle for ${field.key}`;
    const buttons = document.createElement("div");
    buttons.className = "booktitle-parts";
    for (const part of field.parts) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "booktitle-part";
      const label = part.text || "(empty part)";
      button.textContent = label.length > 16 ? `${label.slice(0, 10)} (...)` : label;
      button.title = part.text;
      button.setAttribute("aria-pressed", String(part.included));
      button.addEventListener("click", () => {
        part.included = !part.included;
        const value = field.parts.filter(p => p.included).map(p => p.text).join(", ");
        const next = textarea.value.slice(0, field.start) + value + textarea.value.slice(field.end);
        try {
          // A comma can occur inside a LaTeX group; reject unbalanced selections.
          findBooktitles(next);
        } catch {
          part.included = !part.included;
          message("That selection breaks BibTeX braces or quotes. Edit the booktitle directly instead.", true);
          return;
        }
        // Replace only this value, preserving all other manual edits and delimiters.
        const delta = value.length - field.value.length;
        textarea.value = next;
        field.value = value;
        field.end += delta;
        for (const other of booktitles) {
          if (other.start > field.start) { other.start += delta; other.end += delta; }
        }
        button.setAttribute("aria-pressed", String(part.included));
        message("Edited. Changes are not saved when you close this popup.");
      });
      buttons.append(button);
    }
    // group.append(legend);
    group.append(buttons);
    booktitleControls.append(group);
  }
}


function readPageBibtex() {
  const blocks = [...document.querySelectorAll("pre, textarea")]
    .map(element => element.tagName === "TEXTAREA" ? element.value : element.textContent)
    .map(text => (text ?? "").trim())
    .filter(text => /^@[A-Za-z]+\s*[{(]/.test(text));
  return [...new Set(blocks)].join("\n\n");
}

async function load() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url ?? "about:blank");
    if (!/^https?:$/.test(url.protocol) ||
        !["dblp.org", "dblp.uni-trier.de"].includes(url.hostname) ||
        !url.pathname.startsWith("/rec/")) {
      throw new Error("Open a dblp record’s BibTeX view, then click this button again.");
    }

    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readPageBibtex
    });
    if (!injection?.result) {
      throw new Error("No BibTeX found. Switch this dblp record to its BibTeX view and try again.");
    }

    textarea.value = cleanBibtex(injection.result);
    refreshBooktitles();
    textarea.disabled = false;
    copyButton.disabled = false;
    message("Ready. Changes are not saved when you close this popup.");
    textarea.focus();
    textarea.setSelectionRange(0, 0);
  } catch (error) {
    message(error instanceof Error ? error.message : "Could not read this page.", true);
  }
}

textarea.addEventListener("input", () => {
  refreshBooktitles();
  copyButton.disabled = textarea.value.length === 0;
  message("Edited. Changes are not saved when you close this popup.");
});

copyButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(textarea.value);
    message("Copied to clipboard.");
  });


load();
