// AdminAdvisorSettings.tsx
import React, { useEffect, useMemo, useState, useRef } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import * as XLSX from "xlsx";
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';

// Simple, tailwind-y modal (TOP-LEVEL, not inside any function)
type ModalProps = {
  open: boolean;
  title?: string;
  onClose: () => void;
  children: React.ReactNode;
};

function Modal({ open, title, onClose, children }: ModalProps) {
  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="pointer-events-auto w-[min(900px,92vw)] max-h-[85vh] rounded-2xl bg-white p-4 shadow-xl flex flex-col">
         <div className="p-4 border-b flex items-center justify-between sticky top-0 bg-white rounded-t-2xl">
            <h3 className="text-lg font-semibold">{title}</h3>
            <button type="button" className="px-3 py-1 rounded border" onClick={onClose}>
              Close
            </button>
          </div>
          {/* scrollable content */}
            <div
            className="
              p-4
              overflow-y-auto           /* NEW: vertical scroll */
              overscroll-contain        /* iOS/modern scroll behavior */
              min-h-0 
              [--sbw:8px] pr-2          /* slight right padding for scrollbar */
            "
          >
          {children}
          </div>
        </div>
      </div>
    </div>
  );
}


/** ---------- Types (remove if using .jsx) ---------- */
type FxSettings = {
  base: 'USD'|'EUR'|'JPY'|'GBP'|'AUD'|'CAD'|'CHF'|'NZD';
  tier: 'basic'|'pro'|'advanced';
};

type Branding = {
  firmName: string;
  primary: string;
  secondary: string;
  logoUrl?: string | null;      // external URL
  logoDataUrl?: string | null;  // uploaded inline (base64) for mock/demo
  logoPlacement?: 'none' | 'header' | 'footer' | 'both';
  logoSizeHeader?: number; // px
  logoSizeFooter?: number; // px
  theme?: 'light' | 'dark';
};
type Positions = { chart: string[]; summary: string[] };
type Note = { id: string; title: string; content: string };
type Contact = {
  email: string;
  phone?: string;
  address?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  website?: string;
  websiteLabel?: string;
  twitter?: string;
  linkedin?: string;
  facebook?: string;
  leadEmail?: string;
};
type Footer = { disclaimer: string };
type Disclosure = {
  regulatoryStatus?: string;
  dataSourceDisclosure?: string;
  customDisclaimer?: string;
};

type Settings = {
  branding: Branding;
  positions: Positions;
  notes: Note[];
  contact: Contact;
  disclosure: Disclosure;
  positionsVersion?: number;
  digestCadence?: 'daily' | 'weekly';
  private?: PrivateData;

   // NEW:
  currency: (typeof CURRENCIES)[number];

  // optional: keep fx for future, but without tier in the UI
  fx?: { base: (typeof CURRENCIES)[number] };
  
};
type PrivateItem = {
  id: string;                         // e.g. "PM:APT-12"
  name: string;                       // e.g. "Apt Complex 12"
  unit: 'price' | 'percent';
  freq: 'daily' | 'monthly' | 'quarterly' | 'annual' | string;
  sector?: string;
};
type PrivateData = {
  version: number;
  items: PrivateItem[];
  // epoch millis, value
  series: Record<string, [number, number][]>;
};


/** ---------- Defaults ---------- */
const DEFAULT_SETTINGS: Settings = {
  branding: {
    firmName: "",
    primary: "#2563eb",
    secondary: "#16a34a",
    logoUrl: null,
    logoDataUrl: null,
    logoPlacement: 'header',
    logoSizeHeader: 90,
    logoSizeFooter: 80,
  },
  private: { version: 1, items: [], series: {} },
  positions: {
    chart: ["AAPL", "MSFT", "SPY"],
    summary: ["AAPL", "MSFT", "SPY"],
  },
  notes: [],
  contact: {
    email: "",
    leadEmail: "",
    phone: "",
    address: "",
    address2: "",
    city: "",
    state: "",
    zip: "",
    website: "",
    websiteLabel: "",
    twitter: "",
    linkedin: "",
    facebook: "",
  },
  disclosure: {
    regulatoryStatus: "",
    dataSourceDisclosure: "",
    customDisclaimer: "",
  },
  digestCadence: 'daily',
  // NEW:
  currency: 'USD',

  // keep fx.base if you want (not required by client page)
  fx: { base: 'USD' },
};


/** ---------- Helpers ---------- */
const CURRENCIES = ["USD","EUR","JPY","GBP","AUD","CAD","CHF","NZD"] as const;

const STORAGE_KEY = (slug: string) => `sv:${slug}:firm`; // keep compatibility with your public page

const toArray = (csv: string): string[] =>
  csv
    .split(",")
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

const toCSV = (arr: string[]): string => (arr || []).join(", ");

const fileToDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => resolve(String(rd.result));
    rd.onerror = reject;
    rd.readAsDataURL(file);
  });

function AddPrivateInstrument(props: { onAdd: (item: PrivateItem) => void }) {
  const [name, setName] = React.useState('');
  const [id, setId] = React.useState('');
  const [unit, setUnit] = React.useState<'price' | 'percent'>('price');
  const [freq, setFreq] = React.useState<'daily' | 'monthly' | 'quarterly' | 'annual'>('monthly');
  const [sector, setSector] = React.useState(''); 

  return (
    <form 
      className="rounded border p-3"
      autoComplete="off"                         
      onSubmit={(e) => e.preventDefault()}
    >
      <div className="mb-2 font-semibold">Add instrument</div>

      {/* row 1: inline */}
      <div className="flex flex-wrap items-center gap-3">
        <input 
          className="input w-[22rem]" 
          placeholder="Name (e.g. Apt Complex 12)"
          value={name} 
          onChange={e => setName(e.target.value)} 
          autoComplete="off"                // NEW
          name="private-instrument-name"    // NEW (avoid generic "name")
          spellCheck={false}                // NEW
          autoCorrect="off"                 // NEW
          autoCapitalize="off"              // NEW
          type="search"
        />
        <input 
          className="input w-[16rem]" 
          placeholder="ID (e.g. PM:APT-12)"
          value={id} 
          onChange={e => setId(e.target.value)} 
          autoComplete="off"                // NEW
          name="private-instrument-id"      // NEW (avoid generic "id")
          spellCheck={false}                // NEW
          autoCorrect="off"                 // NEW
          autoCapitalize="off"              // NEW
          type="search"                     // NEW
        />

        <input
          className="input w-48"
          placeholder="Sector (optional)"
          value={sector}
          onChange={(e) => setSector(e.target.value)}
        />

        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600">Price</span>
          <select className="select w-36" value={unit}
                  onChange={e => setUnit(e.target.value as any)}>
            <option value="price">Price</option>
            <option value="percent">% Return</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600">Period</span>
          <select className="select w-36" value={freq}
                  onChange={e => setFreq(e.target.value as any)}>
            <option value="daily">Daily</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="annual">Annual</option>
          </select>
        </div>
      </div>

      {/* row 2: Add button */}
      <div className="mt-3">
        <button
          type="submit"
          className="btn"
          onClick={() => {
            if (!id.trim() || !name.trim()) return;
            props.onAdd({ id: id.trim(), name: name.trim(), unit, freq, sector: sector.trim() || undefined });
            setName(''); setId(''); setUnit('price'); setFreq('monthly');
          }}
        >
          Add
        </button>
      </div>
      <p className="mt-2 text-sm text-gray-500">
        All uploaded or entered values must be in USD. Currency conversions are applied automatically.
      </p>
    </form>
  );
}

function PrivateSeriesEditor(props: {
  itemId: string;
  rows: [number, number][];
  onChange: (rows: [number, number][]) => void;
  onSaved?: () => void;
}) {
  const [tab, setTab] = React.useState<'csv' | 'manual'>('csv');
  const [csvText, setCsvText] = React.useState(rowsToCsv(props.rows));
  const [manualRows, setManualRows] = React.useState<[number, number][]>(
    (props.rows ?? []).slice().sort((a, b) => a[0] - b[0])
  );

  //modal save message
  const [flash, setFlash] = React.useState<"" | "saved" | "reverted" | "error">("");
  const ping = (type: typeof flash) => {
  setFlash(type);
  setTimeout(() => setFlash(""), 1200);
  };


  // keep CSV and manual in sync when switching tabs
  React.useEffect(() => {
    if (tab === 'csv') setCsvText(rowsToCsv(manualRows));
  }, [tab, manualRows]);

  React.useEffect(() => {
    // external change from parent
    setCsvText(rowsToCsv(props.rows));
    setManualRows((props.rows ?? []).slice().sort((a, b) => a[0] - b[0]));
  }, [props.itemId]);

  useEffect(() => {
    document.title = "Quiet Pitch";
  }, []);

  return (
    <div className="border rounded p-3 space-y-3">
      <div className="flex gap-2">
        <button
          className={`btn ${tab === 'csv' ? 'btn-primary' : ''}`}
          onClick={() => setTab('csv')}
        >
          CSV / Excel
        </button>
        <button
          className={`btn ${tab === 'manual' ? 'btn-primary' : ''}`}
          onClick={() => setTab('manual')}
        >
          Manual
        </button>
      </div>

      {tab === 'csv' ? (
        <>
          <p className="text-sm text-gray-600">
            Paste one entry per line as <code>YYYY-MM-DD,value</code>
          </p>
  <input
    type="file"
    accept=".csv,.xlsx,.xls,text/csv"
    onChange={async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;

      if (/\.(xlsx|xls)$/i.test(f.name)) {
        // Excel
        const buf = await f.arrayBuffer();
        const wb = XLSX.read(buf);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<any>(ws, { header: 1 }) as any[][];

      // Expect either headers [date, value] or raw rows with 2 columns
        const body = rows[0] && typeof rows[0][0] === 'string' ? rows.slice(1) : rows;
        const parsed = body
          .map(r => [Date.parse(String(r[0])), Number(r[1])] as [number, number])
          .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v))
          .sort((a, b) => a[0] - b[0]);

        setCsvText(rowsToCsv(parsed));   // keep textarea in sync
        setManualRows(parsed);
      } else {
        // CSV
        const text = await f.text();
        setCsvText(text);
        const rows = parseCsvToRows(text);
        setManualRows(rows);
      }
    }}
    className="block"
  />
          <textarea
            className="textarea w-full h-40"
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              className="btn"
              onClick={() => {
                const rows = parseCsvToRows(csvText);
                setManualRows(rows);
                props.onChange(rows);
                ping("saved");
              }}
            >
              Save series
            </button>
            <button
              className="btn"
              onClick={() => {
                setCsvText(rowsToCsv(props.rows));
                setManualRows((props.rows ?? []).slice());
              }}
            >
              Revert
            </button>
            {/* flash message */}
            <span
              aria-live="polite"
              className={
                flash === "saved"
                  ? "text-green-600 font-medium"
                  : flash === "reverted"
                  ? "text-gray-600"
                  : "invisible"
              }
            >
              {flash === "saved" ? "Saved!" : flash === "reverted" ? "Reverted" : "…"}
            </span>
          </div>
        </>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="table w-full">
              <thead>
                <tr>
                  <th style={{ width: 160 }}>Date</th>
                  <th style={{ width: 160 }}>Value</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {manualRows.map(([t, v], i) => (
                  <tr key={i}>
                    <td>
                      <input
                        type="date"
                        className="input"
                        value={toDateInput(t)}
                        onChange={(e) => {
                          const d = fromDateInput(e.target.value);
                          setManualRows((rows) => {
                            const next = rows.slice();
                            next[i] = [d, v];
                            return next;
                          });
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        inputMode="decimal"
                        className="input"
                        value={Number.isFinite(v) ? String(v) : ''}   // allow blank
                        onChange={(e) => {
                          const raw = e.target.value;                 // don't coerce yet
                          setManualRows((rows) => {
                            const next = rows.slice();
                            next[i] = [t, raw === '' ? NaN : Number(raw)];  // blank -> NaN
                            return next;
                          });
                        }}
                      />

                    </td>
                    <td>
                      <button
                        className="btn"
                        onClick={() =>
                          setManualRows((rows) => rows.filter((_, j) => j !== i))
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3}>
                    <button
                      className="btn"
                      onClick={() =>
                        setManualRows((rows) => [
                          ...rows,
                          [Date.parse(new Date().toISOString().slice(0, 10)), 0],
                        ])
                      }
                    >
                      + Add row
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="flex gap-2">
            <button
              className="btn"
              onClick={() => {
                const cleaned = manualRows
                  .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v))
                  .slice()
                  .sort((a, b) => a[0] - b[0]);
                setManualRows(cleaned);
                setCsvText(rowsToCsv(cleaned));
                props.onChange(cleaned);
                ping("saved");
              }}
            >
              Save series
            </button>
            <button
              className="btn"
              onClick={() => {
                setManualRows((props.rows ?? []).slice());
                setCsvText(rowsToCsv(props.rows));
                ping("reverted")
              }}
            >
              Revert
            </button>
            {/* flash message */}
            <span
              aria-live="polite"
              className={
                flash === "saved"
                  ? "text-green-600 font-medium"
                  : flash === "reverted"
                  ? "text-gray-600"
                  : "invisible"
              }
            >
              {flash === "saved" ? "Saved!" : flash === "reverted" ? "Reverted" : "…"}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** "YYYY-MM-DD,value" per line -> [ [utcMillis, number], ... ] */
function parseCsvToRows(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const [dateStr, valStr] = line.split(',').map(s => (s ?? '').trim());
    const t = Date.parse(dateStr);
    const v = Number(valStr);
    if (Number.isFinite(t) && Number.isFinite(v)) out.push([t, v]);
  }
  // sort ascending by time
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/** rows -> CSV string "YYYY-MM-DD,value" per line */
function rowsToCsv(rows: [number, number][]): string {
  return (rows ?? [])
    .slice()
    .sort((a, b) => a[0] - b[0])
    .map(([t, v]) => `${new Date(t).toISOString().slice(0, 10)},${v}`)
    .join('\n');
}

/** UTC millis -> "YYYY-MM-DD" */
function toDateInput(t: number): string {
  if (!Number.isFinite(t)) return '';
  return new Date(t).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" -> UTC millis (NaN if invalid) */
function fromDateInput(s: string): number {
  return Date.parse(s);
}

function RichTextEditor({
  value,
  onChange,
  placeholder = 'Write here…',
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({
        openOnClick: true,
        validate: href => /^https?:\/\//i.test(href),
        HTMLAttributes: {
          target: '_blank',
          rel: 'noopener noreferrer'
        }
      }),
    ],
    content: value || '',
    editorProps: {
      attributes: {
        class:
          'prose max-w-none p-3 min-h-[8rem] border rounded focus:outline-none',
      },
    } as any,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    onSelectionUpdate: () => {}
  });

  React.useEffect(() => {
  if (!editor) return;
  const html = value || '';
  // avoid infinite loop by only setting when different
  if (html !== editor.getHTML()) {
    editor.commands.setContent(html, { emitUpdate: false });
  }
}, [value, editor]);

  const [, force] = React.useReducer((x) => x + 1, 0);

  React.useEffect(() => {
    if (!editor) return;
    const rerender = () => force();

    editor.on('selectionUpdate', rerender);
    editor.on('transaction', rerender);
    editor.on('update', rerender);

    return () => {
      editor.off('selectionUpdate', rerender);
      editor.off('transaction', rerender);
      editor.off('update', rerender);
    };
  }, [editor]);

  if (!editor) return null;

  const addOrEditLink = () => {
  const hasSelection = editor && !editor.state.selection.empty;
  const inLink = editor.isActive('link');
  const canUnlink = inLink; 

  // If no selection and not inside a link, don't open the prompt
  if (!hasSelection && !inLink) {
    window.alert('Select some text to link first.');
    return;
  }

  const prev = editor.getAttributes('link')?.href || '';
  const url = window.prompt('Enter URL (https://…)', prev);
  if (url === null) return;            // user canceled

  if (!url) {
    // blank -> remove link (works on selection or current link mark)
    editor.chain().focus().unsetLink().run();
    return;
  }

  // validate basic http/https
  if (!/^https?:\/\//i.test(url)) {
    window.alert('Please enter a valid http(s) URL.');
    return;
  }

  // set or update link on current selection / mark range
  editor
    .chain()
    .focus()
    .extendMarkRange('link')
    .setLink({ href: url })
    .run();
};

const hasSelection = !!editor && !editor.state.selection.empty;
const inLink = editor.isActive('link');
const canLink = hasSelection || inLink;  // allow edit when cursor is in a link
const canUnlink = inLink; 

  return (
    <div className="border rounded">
      <div className="flex flex-wrap gap-2 p-2 border-b bg-gray-50">
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={`px-2 py-1 rounded border ${editor.isActive('bold') ? 'bg-gray-900 text-white' : 'bg-white'}`}
          aria-label="Bold"
          title="Bold"
        >
          <span className="font-bold">B</span>
    </button>
  <button
    type="button"
    onClick={() => editor.chain().focus().toggleItalic().run()}
    className={`px-2 py-1 rounded border ${editor.isActive('italic') ? 'bg-gray-900 text-white' : 'bg-white'}`}
    aria-label="Italic"
    title="Italic"
  >
    <span className="italic">I</span>
  </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={`px-2 py-1 rounded ${editor.isActive('bulletList') ? 'bg-gray-300' : 'bg-white'}`}
        >
          • List
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          className={`px-2 py-1 rounded ${editor.isActive('orderedList') ? 'bg-gray-300' : 'bg-white'}`}
        >
          1. List
        </button>
       <span
  title={canLink ? 'Insert or edit link' : 'Select text to add a link'}
  className="inline-flex"
>
  <button
    type="button"
    onClick={addOrEditLink}
    disabled={!canLink}
    className={`px-2 py-1 rounded border ${
      inLink ? 'bg-gray-900 text-white' : 'bg-white'
    } ${!canLink ? 'opacity-50' : ''}`}  // ← no cursor-not-allowed
    aria-label="Link"
    aria-pressed={inLink}
  >
    Link
  </button>
</span>

<span
  title={canUnlink ? 'Remove link' : 'Place the cursor in a link to remove it'}
  className="inline-flex"
>
  <button
    type="button"
    onClick={() => editor.chain().focus().unsetLink().run()}
    disabled={!canUnlink}
    className={`px-2 py-1 rounded border bg-white ${
      !canUnlink ? 'opacity-50' : ''
    }`}
    aria-label="Unlink"
  >
    Unlink
  </button>
</span>
      </div>

      <EditorContent editor={editor} />
      {!value && (
        <div className="pointer-events-none -mt-10 ml-4 text-gray-400 select-none">
          {placeholder}
        </div>
      )}
    </div>
  );
}

/** ---------- Component ---------- */
export default function AdminAdvisorSettings() {
  const { slug } = useParams();
  const [sp] = useSearchParams();
  const [data, setData] = useState<Settings>(DEFAULT_SETTINGS);
  const [savedMsg, setSavedMsg] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [lastSaved, setLastSaved] = useState<Settings | null>(null);
  const [chartCsv, setChartCsv] = useState("");
  const [summaryCsv, setSummaryCsv] = useState("");
  const hasUnsaved = (() => {
    if (!lastSaved) return true;
    const lastChart   = toCSV(lastSaved.positions?.chart   || []);
    const lastSummary = toCSV(lastSaved.positions?.summary || []);
    return (
      chartCsv !== lastChart ||
      summaryCsv !== lastSummary ||
      JSON.stringify(data.branding) !== JSON.stringify(lastSaved.branding) ||
      JSON.stringify(data.contact)  !== JSON.stringify(lastSaved.contact)  ||
      JSON.stringify(data.disclosure)   !== JSON.stringify(lastSaved.disclosure)   ||
      JSON.stringify(data.notes)    !== JSON.stringify(lastSaved.notes)    ||
      (data.digestCadence ?? 'daily') !== (lastSaved.digestCadence ?? 'daily') ||
      JSON.stringify(data.private)  !== JSON.stringify(lastSaved.private) ||
      data.currency !== lastSaved.currency
    );
  })();  
  const [positionsChartText, setPositionsChartText] = useState("");
  const [positionsSummaryText, setPositionsSummaryText] = useState("");
  const hasLogo = !!(data.branding.logoDataUrl || data.branding.logoUrl);
  const [showLogoInputs, setShowLogoInputs] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const openEditor = (id: string) => setEditingItemId(id);
  const closeEditor = () => setEditingItemId(null);

  useEffect(() => {
    console.log('[ADMIN STATE]', {
      currency: data.currency,
    });
  }, [data.currency]);

  // put this inside AdminAdvisorSettings(), near other helpers
const updatePrivateItem = (id: string, patch: Partial<PrivateItem>) => {
  setData(prev => {
    const p = prev.private ?? { version: 1, items: [], series: {} };
    const items = p.items.map(it =>
      it.id === id ? { ...it, ...patch } : it
    );

    const nextPrivate = { ...p, items };

    // 🔒 SAFE SAVE (currency preserved)
    persistSettings({ private: nextPrivate });

    return { ...prev, private: nextPrivate };
  });
};

React.useEffect(() => {
  document.body.classList.add('qp-admin', 'qp-mesh');
  return () => {
    document.body.classList.remove('qp-admin', 'qp-mesh');
  };
}, []);

  //normalize fix
  const clamp = (n: number, min: number, max: number) => Math.min(Math.max(Number.isFinite(n as any) ? Number(n) : min, min), max);

const normalize = (s: Settings): Settings => {
  const branding = (s.branding ?? ({} as Branding));
  const hasLogo = !!(s.branding.logoDataUrl || s.branding.logoUrl);
  const lp = s.branding.logoPlacement ?? (hasLogo ? 'header' : 'none');

  return {
    ...s,
    currency: (s.currency ?? DEFAULT_SETTINGS.currency),
    branding: {
      ...s.branding,
      logoPlacement: lp,
      logoSizeHeader: clamp(s.branding.logoSizeHeader ?? 48, 12, 100),
      logoSizeFooter: clamp(s.branding.logoSizeFooter ?? 20, 12, 120),
    },
  };
};

// 🔒 SINGLE SOURCE OF TRUTH FOR SAVING SETTINGS
const persistSettings = async (patch: Partial<Settings>) => {
  if (!slug) return;

  let previous: Settings;
  try {
    const raw = localStorage.getItem(STORAGE_KEY(slug));
    previous = raw ? JSON.parse(raw) : DEFAULT_SETTINGS;
  } catch {
    previous = DEFAULT_SETTINGS;
  }

  const merged = normalize({
    ...previous,
    ...patch,
    currency: patch.currency ?? previous.currency,
  });

  // persist locally first so UI stays in sync
  localStorage.setItem(STORAGE_KEY(slug), JSON.stringify(merged));

  try {
    const saved = await saveToCosmos(slug, merged);
    localStorage.setItem(STORAGE_KEY(slug), JSON.stringify(saved));
    setData(saved);
    setLastSaved(saved);
  } catch {
    // optional: toast later
  }
};

const [form, setForm]   = useState<Settings>(() => normalize(DEFAULT_SETTINGS));
const [saved, setSaved] = useState<Settings>(() => normalize(DEFAULT_SETTINGS));

  // Load existing saved settings (cloud → localStorage fallback), then normalize
useEffect(() => {
  if (!slug) return;

  (async () => {
    // 1️⃣ Try local first
    let local: Partial<Settings> | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY(slug));
      local = raw ? JSON.parse(raw) : null;
    } catch {}

    // ✅ If we have local edits (especially notes), use them immediately
    if (local && Array.isArray(local.notes) && local.notes.length > 0) {
      const merged = normalize({
        ...(DEFAULT_SETTINGS as Settings),
        ...(local ?? {}),
        currency: local?.currency ?? DEFAULT_SETTINGS.currency,
      });
      setData(merged);
      setChartCsv((merged.positions?.chart ?? []).join(', '));
      setSummaryCsv((merged.positions?.summary ?? []).join(', '));
      setLastSaved(merged);
      return;
    }

    // 2️⃣ Otherwise fetch from Cosmos (cloud)
    try {
      const cloud = await loadFromCosmos(slug);
      const merged = normalize({
        ...(DEFAULT_SETTINGS as Settings),
        ...(cloud ?? {}),
        currency: cloud?.currency ?? DEFAULT_SETTINGS.currency,
      });
      setData(merged);
      setChartCsv((merged.positions?.chart ?? []).join(', '));
      setSummaryCsv((merged.positions?.summary ?? []).join(', '));
      setLastSaved(merged);

      // persist for next reload
      localStorage.setItem(STORAGE_KEY(slug), JSON.stringify(merged));
    } catch {
      // fallback to defaults
      setData(DEFAULT_SETTINGS);
    }
  })();
}, [slug]);

  // Save to localStorage
  const norm = (csv: string) =>
    csv.split(/[, \s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  
  const save = async () => {
    if (!data.disclosure?.regulatoryStatus) {
      setError("Please select a regulatory status before saving.");
      return;
    }
    if (!slug) return;
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY(slug)) || "{}");
    const nextV = Number(stored.positionsVersion || 0) + 1;

  
    const next: Settings & { positionsVersion: number } = {
      ...data,
      currency: data.currency,
      digestCadence: data.digestCadence ?? 'daily',
      positions: {
        chart:   norm(chartCsv),
        summary: norm(summaryCsv),
      },
      positionsVersion: nextV,
    };

    // 1️⃣ Load previously saved settings (from localStorage)
let previous: Settings;
try {
  const raw = localStorage.getItem(STORAGE_KEY(slug));
  previous = raw ? JSON.parse(raw) : DEFAULT_SETTINGS;
} catch {
  previous = DEFAULT_SETTINGS;
}

// 2️⃣ Merge previous settings with what the UI just changed
const merged: Settings = {
  ...previous,
  ...next,
  currency: next.currency ?? previous.currency, // 🔒 THIS LINE FIXES THE BUG
};

// 3️⃣ Normalize AFTER merge
const normed = normalize(merged);

try {
  // 4️⃣ Save to Cosmos FIRST (authoritative)
  const saved = await saveToCosmos(slug, normed);

  // 5️⃣ Persist what Cosmos accepted
  localStorage.setItem(STORAGE_KEY(slug), JSON.stringify(saved));

  // 6️⃣ Sync UI from authoritative data
  setData(saved);
  setLastSaved(saved);
  setChartCsv((saved.positions?.chart ?? []).join(", "));
  setSummaryCsv((saved.positions?.summary ?? []).join(", "));
  setSavedMsg("Saved!");
  setError("");
  setTimeout(() => setSavedMsg(""), 1200);
} catch (e: any) {
  setError(e.message || "Save failed");
}

  };
  
  //logo settings appear only when needed
  const setBrand = (patch: Partial<Branding>) =>
    setData(d => ({ ...d, branding: { ...d.branding, ...patch } }));
  

  // Update helpers
  const setPositionsCSV = (key: keyof Positions, csv: string) =>
    setData(d => ({ ...d, positions: { ...d.positions, [key]: toArray(csv) } }));

  const updateNote = (id: string, patch: Partial<Note>) =>
    setData(d => ({
      ...d,
      notes: d.notes.map(n => (n.id === id ? { ...n, ...patch } : n)),
    }));

  const addNote = () =>
    setData(d => ({
      ...d,
      notes: [...d.notes, { id: `n${Date.now()}`, title: "", content: "" }],
    }));

  const removeNote = (id: string) =>
    setData(d => ({ ...d, notes: d.notes.filter(n => n.id !== id) }));

  const setContact = (patch: Partial<Contact>) =>
    setData(d => ({ ...d, contact: { ...d.contact, ...patch } }));

  const setFooter = (patch: Partial<Footer>) =>
    setData(d => ({ ...d, footer: { ...d.disclosure, ...patch } }));

  const onLogoFile = async (file: File | null) => {
    if (!file) return;
    try {
      const url = await fileToDataUrl(file);
      setBrand({ 
        logoDataUrl: url, 
        logoUrl: null, 
        logoPlacement: 
          data.branding.logoPlacement && data.branding.logoPlacement !== 'none'
            ? data.branding.logoPlacement
            : 'header',
      });
      setShowLogoInputs(false);
    } catch {
      setError("Failed to read logo file.");
      setTimeout(() => setError(""), 1800);
    }
  };

  if (!slug) return <div className="p-6 text-red-600">Missing slug in URL.</div>;


  //helper that saves to cosmos
  const API_BASE = "https://quietpitch-funcapp-axfccbhygagpbkdw.eastus-01.azurewebsites.net/api";;

  async function loadFromCosmos(slug: string) {
    const res = await fetch(`${API_BASE}/private/advisors/${slug}/settings`);
  if (!res.ok) throw new Error(`GET failed (${res.status})`);
  const data = await res.json();
  console.log('[LOAD ← COSMOS]', {
    currency: data?.currency,
    fx: data?.fx,
  });
  return data;
}

async function saveToCosmos(slug: string, s: Settings) {
  console.log('[SAVE → COSMOS]', {
    slug,
    currency: s.currency,
    fx: s.fx,
  });
  const base = "https://quietpitch-funcapp-axfccbhygagpbkdw.eastus-01.azurewebsites.net/api";   // ✅ define base here
  
  const res = await fetch(`${base}/private/advisors/${slug}/settings`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-admin-key": slug
    },
    body: JSON.stringify({
      id: `adv-${slug}`,
      advisorSlug: slug,
      currency: s.currency,
      branding: s.branding,
      contact:  s.contact,
      disclosure:   s.disclosure,
      digestCadence: s.digestCadence ?? 'daily',
      positions: s.positions,
      positionsVersion: s.positionsVersion ?? 0,
      notes: s.notes,
      private: s.private ?? { version: 1, items: [], series: {} },
      fx: s.fx ?? { base: 'USD', tier: 'basic' },
    })
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Save failed (${res.status}) ${txt}`);
  }

  const saved = await res.json();
  console.log('[COSMOS → RESPONSE]', {
    currency: saved?.currency,
    fx: saved?.fx,
  });

  // Mirror to localStorage so refresh shows exactly this version
  try {
    localStorage.setItem(STORAGE_KEY(slug), JSON.stringify(saved));
  } catch {}

  return saved;
}

// top of page starts here
  return (
    <main className="max-w-3xl mx-auto p-6 space-y-6">
      {/* ...ALL your existing admin content... */}

      <h1 className="text-2xl font-semibold text-slate-50 drop-shadow-md bg-slate-900/40 inline-block px-3 py-2 rounded-xl">
        Quiet Pitch — Admin ({slug})
      </h1>

      {/* Branding */}
      <section className="border rounded-2xl p-4 space-y-4 bg-white">
        <h2 className="font-semibold">Branding</h2>

        <label className="block">
          <span className="text-sm">Public Firm Name</span>
          <input
            className="border rounded w-full p-2"
            value={data.branding.firmName}
            onChange={e => setBrand({ firmName: e.target.value })}
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm">Primary color</span>
            <input
              type="color"
              className="border rounded w-full h-10 p-1"
              value={data.branding.primary}
              onChange={e => setBrand({ primary: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="text-sm">Secondary color</span>
            <input
              type="color"
              className="border rounded w-full h-10 p-1"
              value={data.branding.secondary}
              onChange={e => setBrand({ secondary: e.target.value })}
            />
          </label>
        </div>

        <div className="mt-4">
  <div className="text-sm font-medium mb-1">Theme</div>
  <div className="flex items-center gap-4">
    <label className="inline-flex items-center gap-2">
      <input
        type="radio"
        name="branding-theme"
        value="light"
        checked={(data.branding?.theme ?? 'light') === 'light'}
        onChange={() => {
          const theme: 'light' | 'dark' = 'light';
          setData(prev => ({ ...prev, branding: { ...prev.branding, theme } }));
        }}
      />
      <span>Light</span>
    </label>

    <label className="inline-flex items-center gap-2">
      <input
        type="radio"
        name="branding-theme"
        value="dark"
        checked={data.branding?.theme === 'dark'}
        onChange={() => {
          const theme: 'light' | 'dark' = 'dark';
          setData(prev => ({ ...prev, branding: { ...prev.branding, theme } }));
        }}
      />
      <span>Dark</span>
    </label>
  </div>
</div>

        {/* Logo input row (hide when a logo exists unless “Change” is clicked) */}
        {(!hasLogo || showLogoInputs) ? (
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm">Logo (upload)</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="block w-full"
              onChange={e => onLogoFile(e.target.files?.[0] || null)}
            />
          </label>
          <label className="block">
            <span className="text-sm">Logo URL (optional)</span>
            <input
              className="border rounded w-full p-2"
              placeholder="https://…"
              value={data.branding.logoUrl || ""}
              onChange={e => {
                const v = e.target.value.trim();
                setBrand({
                  logoUrl: v || null,
                  logoDataUrl: null,
                  logoPlacement: v
                    ? (data.branding.logoPlacement && data.branding.logoPlacement !== 'none' ? data.branding.logoPlacement : 'header')
                    : 'none',
                  });
                }}
                onBlur={() => {
                  // if a URL is present, collapse the inputs
                  if ((data.branding.logoUrl || "").trim()) setShowLogoInputs(false);
                }}
            />
          </label>
        </div>
      ) : null}

        {hasLogo ? (
        <div className="grid grid-cols-3 gap-3">
  <label className="block">
    <span className="text-sm">Logo placement</span>
    <select
      className="border rounded w-full p-2"
      value={data.branding.logoPlacement || 'none'}
      onChange={e => setBrand({ logoPlacement: e.target.value as any })}
    >
      <option value="none">None</option>
      <option value="header">Header</option>
      <option value="footer">Footer</option>
      <option value="both">Both</option>
    </select>
  </label>

  <label className="block">
    <span className="text-sm">Header logo height (px)</span>
    <input
      type="number"
      min={16}
      max={120}
      className="border rounded w-full p-2"
      value={data.branding.logoSizeHeader ?? 90}
      onChange={e => setBrand({ logoSizeHeader: Number(e.target.value || 90) })}
    />
  </label>

  <label className="block">
    <span className="text-sm">Footer logo height (px)</span>
    <input
      type="number"
      min={12}
      max={120}
      className="border rounded w-full p-2"
      value={data.branding.logoSizeFooter ?? 80}
      onChange={e => setBrand({ logoSizeFooter: Number(e.target.value || 80) })}
    />
  </label>
</div>
) : (
  <div className="text-sm text-gray-500">
    Upload a logo (or paste a Logo URL) to enable placement and size options.
  </div>
)}

          {hasLogo && (
          <div className="flex items-center gap-3">
            <img
              src={data.branding.logoDataUrl || data.branding.logoUrl || ""}
              alt="Logo preview"
              className="h-12 w-auto border rounded"
            />

          <div className="flex gap-2">
            <button
              className="px-2 py-1 text-sm bg-gray-200 rounded"
              onClick={() => setShowLogoInputs(s => !s)}
            >
            {showLogoInputs ? "Cancel" : "Change logo"}
            </button>

            <button
              className="px-2 py-1 text-sm bg-gray-200 rounded"
              onClick={() => {
                setBrand({ logoDataUrl: null, logoUrl: null, logoPlacement: 'none' });
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
            >
              Remove logo
            </button>
          </div>
        </div>
        )}
      </section>

      {/* ==== Currency (admin sets the public page currency) ==== */}
<section className="border rounded-2xl p-4 space-y-2 bg-white">
  <h2 className="font-semibold">Currency</h2>
  <p className="text-sm text-slate-600">
    Choose the default currency shown on the public page
  </p>
  <select
    className="select"
    value={data.currency}
    onChange={(e) =>
      setData(d => ({ ...d, currency: e.target.value as (typeof CURRENCIES)[number] }))
    }
  >
    {CURRENCIES.map(c => (
      <option key={c} value={c}>{c}</option>
    ))}
  </select>
  <p className="text-xs text-gray-500">
    Basic plan shows a daily “as of” for FX.
  </p>
</section>

      {/* Default Positions */}
      <section className="border rounded-2xl p-4 space-y-3 bg-white">
        <h2 className="font-semibold">Default Positions</h2>
        <label className="block">
  <span className="text-sm">Chart tickers (comma separated)</span>
  <input
    className="border rounded w-full p-2"
    value={chartCsv}
    onChange={e => setChartCsv(e.target.value)}
    onBlur={() => setChartCsv(toCSV(toArray(chartCsv)))}   // optional tidy on blur
    placeholder="AAPL, MSFT, SPY"
  />
</label>

<label className="block">
  <span className="text-sm">Summary tickers (comma separated)</span>
  <input
    className="border rounded w-full p-2"
    value={summaryCsv}
    onChange={e => setSummaryCsv(e.target.value)}
    onBlur={() => setSummaryCsv(toCSV(toArray(summaryCsv)))} // optional tidy on blur
    placeholder="AAPL, MSFT, SPY"
  />
</label>
      </section>

      {/* Private Market (manual entry) */}
<section className="border rounded-2xl p-4 space-y-3 bg-white">
  <h2 className="font-semibold">Private Market (manual)</h2>

  {/* Add instrument */}
  <AddPrivateInstrument
    onAdd={(item) => {
      setData((f) => {
        const p = f.private ?? { version: 1, items: [], series: {} };
        if (p.items.some((x) => x.id === item.id)) return f; // no duplicates
        return {
          ...f,
          private: {
            ...p,
            items: [...p.items, item],
            series: { ...p.series, [item.id]: p.series[item.id] ?? [] },
          },
        };
      });
      setTimeout(() => {
        if (confirm("Instrument added. Add series data now?")) {
        // open the modal for this item
        openEditor(item.id);
      }
    }, 0)
    }}
  />

  {/* List and edit series */}
  {(data.private?.items ?? []).map((it) => (
  <div key={it.id} className="py-3">
    <div className="flex items-center justify-between">
      <div>
        <div className="font-medium">
          {it.name} <span className="text-xs text-gray-400">({it.id})</span>
        </div>
        <div className="text-xs text-gray-500 flex flex-wrap items-center gap-2">
  <span>Unit: {it.unit} · Freq: {it.freq}</span>
  <span>·</span>
  <label className="inline-flex items-center gap-1">
    <span>Sector:</span>
    <input
      className="input h-6 px-2 py-1 text-xs"
      placeholder="(optional)"
      value={it.sector || ""}
      onChange={(e) =>
        updatePrivateItem(it.id, {
          sector: e.target.value.trim() || undefined,
        })
      }
    />
  </label>
</div>
      </div>
      <div className="flex gap-2">
        <button className="btn" onClick={() => openEditor(it.id)}>Edit series</button>
        <button
          className="px-2 py-1 text-sm bg-red-600 text-white rounded"
          onClick={() => {
            if (!confirm(`Remove ${it.name}?`)) return;
            setData(prev => {
              const p = prev.private ?? { version: 1, items: [], series: {} };
              const items = p.items.filter(x => x.id !== it.id);
              const nextSeries = { ...p.series };
              delete nextSeries[it.id];

              const next = { ...prev, private: { ...p, items, series: nextSeries } };

              persistSettings({ private: next.private });

              // keep lastSaved in sync with immediate change so Discard doesn’t re-add
              setLastSaved(ls => (ls ? { ...ls, private: { ...p, items, series: nextSeries } } : ls));

              return next;
            });
          }}
        >
        Remove
        </button>
      </div>
    </div>
  </div>
))}

<Modal
  open={!!editingItemId}
  title={`Edit series — ${editingItemId ?? ''}`}
  onClose={closeEditor}
>
  {editingItemId && (
    <PrivateSeriesEditor
      itemId={editingItemId}
      rows={data.private?.series?.[editingItemId] ?? []}
      onChange={(rows) => {
        // persist private series immediately so refresh keeps it
        setData((f) => {
          const p = f.private ?? { version: 1, items: [], series: {} };
          const next: Settings = {
            ...f,
            private: { ...p, series: { ...p.series, [editingItemId]: rows } },
          };

          persistSettings({ private: next.private });

          return next;
        });

        // 3) keep lastSaved in sync so page-level "Discard" won't fight modal edits
        setLastSaved((s) => {
          if (!s) return s;
          const p = s.private ?? { version: 1, items: [], series: {} };
          return { ...s, private: { ...p, series: { ...p.series, [editingItemId]: rows } } };
        });
      }}
      onSaved={() => {
        // keep your bottom "Saved!" banner behavior
        setSavedMsg("Saved!");
        setTimeout(() => setSavedMsg(""), 1200);
      }}
    />
  )}
</Modal>
    
</section>

      {/* Market Commentary */}
      <section className="border rounded-2xl p-4 space-y-3 bg-white">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Market Commentary</h2>
          <button className="px-2 py-1 bg-gray-800 text-white rounded" onClick={addNote}>
            + Add note
          </button>
        </div>

        <div className="space-y-3">
          {data.notes.map(n => (
            <div key={n.id} className="border rounded p-3">
              <div className="flex gap-2 mb-2">
                <input
                  className="border rounded p-2 w-full"
                  placeholder="Title"
                  value={n.title}
                  onChange={e => updateNote(n.id, { title: e.target.value })}
                />
                <button
                  className="px-2 py-1 bg-red-600 text-white rounded"
                  onClick={() => {
                    if (confirm('Remove this note?')) removeNote(n.id);
                  }}
                >
                  Remove
                </button>
              </div>
              <RichTextEditor
                key={n.id}
                value={n.content}
                onChange={(html) => updateNote(n.id, { content: html })}
              />
            </div>
          ))}
          {data.notes.length === 0 && (
            <div className="text-sm text-gray-500">No notes yet.</div>
          )}
        </div>
      </section>

      {/* Contact & Social */}
      <section className="border rounded-2xl p-4 space-y-3 bg-white">
        <h2 className="font-semibold">Contact & Social</h2>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm">Email</span>
            <input
              className="border rounded w-full p-2"
              value={data.contact.email}
              onChange={e => setContact({ email: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="text-sm">Phone</span>
            <input
              className="border rounded w-full p-2"
              value={data.contact.phone || ""}
              onChange={e => setContact({ phone: e.target.value })}
            />
          </label>
        </div>

        <label className="block">
          <span className="text-sm">Address</span>
          <input
            className="border rounded w-full p-2"
            value={data.contact.address || ""}
            onChange={e => setContact({ address: e.target.value })}
          />
        </label>

        <label className="block">
          <span className="text-sm">Address 2</span>
          <input
            className="border rounded w-full p-2"
            value={data.contact.address2 || ""}
            onChange={e => setContact({ address2: e.target.value })}
          />
        </label>

        <label className="block">
          <span className="text-sm">City</span>
          <input
            className="border rounded w-full p-2"
            value={data.contact.city || ""}
            onChange={e => setContact({ city: e.target.value })}
          />
        </label>

        <label className="block">
          <span className="text-sm">State</span>
          <input
            className="border rounded w-full p-2"
            value={data.contact.state || ""}
            onChange={e => setContact({ state: e.target.value })}
          />
        </label>

        <label className="block">
          <span className="text-sm">Zip Code</span>
          <input
            className="border rounded w-full p-2"
            value={data.contact.zip || ""}
            onChange={e => setContact({ zip: e.target.value })}
          />
        </label>

        <label className="block">
          <span className="text-sm">Website</span>
          <input
            className="border rounded w-full p-2"
            placeholder="https://…"
            value={data.contact.website || ""}
            onChange={e => setContact({ website: e.target.value })}
          />
        </label>

        <label className="block">
          <span className="text-sm">Website Label</span>
          <input
            className="border rounded w-full p-2"
            placeholder="e.g. Visit our site"
            value={data.contact.websiteLabel || ""}
            onChange={e => setContact({ websiteLabel: e.target.value })}
          />
        </label>
          
        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className="text-sm">Twitter / X</span>
            <input
              className="border rounded w-full p-2"
              value={data.contact.twitter || ""}
              onChange={e => setContact({ twitter: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="text-sm">LinkedIn</span>
            <input
              className="border rounded w-full p-2"
              value={data.contact.linkedin || ""}
              onChange={e => setContact({ linkedin: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="text-sm">Facebook</span>
            <input
              className="border rounded w-full p-2"
              value={data.contact.facebook || ""}
              onChange={e => setContact({ facebook: e.target.value })}
            />
          </label>

          <div className="col-span-3 md:col-span-1">
  <label htmlFor="leadEmail" className="block text-sm whitespace-nowrap">
    Lead Email (where “Contact Advisor” sends)
  </label>
  <input
    id="leadEmail"
    className="border rounded w-full p-2"
    value={data.contact.leadEmail || ""}
    onChange={e => setContact({ leadEmail: e.target.value })}
  />

  {/* Cadence sits directly below the email input */}
  <fieldset className="mt-3 border-t border-slate-200 pt-3">
    <legend className="text-sm font-medium">Lead summary cadence</legend>

    {/* Side-by-side on all sizes; wraps only if space is too tight */}
    <div className="mt-2 flex flex-row flex-wrap items-center gap-6">
      <label className="inline-flex items-center gap-2">
        <input
          type="radio"
          name="digestCadence"
          checked={(data.digestCadence ?? 'daily') === 'daily'}
          onChange={() => setData(d => ({ ...d, digestCadence: 'daily' }))}
        />
        <span className="text-sm leading-snug">Daily (weekdays 8am)</span>
      </label>

      <label className="inline-flex items-center gap-2">
        <input
          type="radio"
          name="digestCadence"
          checked={data.digestCadence === 'weekly'}
          onChange={() => setData(d => ({ ...d, digestCadence: 'weekly' }))}
        />
        <span className="text-sm leading-snug">Weekly (Mondays 8am)</span>
      </label>
    </div>
  </fieldset>
</div>


        </div>
      </section>

      {/* Disclosure Section */}
<section className="border rounded-2xl p-4 space-y-3 bg-white">
  <h2 className="text-lg font-semibold">Disclosure</h2>

  {/* Regulatory Status */}
  <div>
    <label className="block font-medium mb-1">
      Regulatory Status <span className="text-red-600">*</span>
    </label>
    <select
      className="border rounded w-full p-2"
      value={data.disclosure?.regulatoryStatus || ""}
      onChange={(e) =>
        setData({
          ...data,
          disclosure: {
            ...data.disclosure,
            regulatoryStatus: e.target.value,
          },
        })
      }
    >
      <option value="" disabled>Select...</option>
      <option value="Not registered / Educational content only">Not registered / Educational</option>
      <option value="Registered Investment Adviser (RIA)">RIA (Registered Investment Adviser)</option>
      <option value="Broker-Dealer">Broker-Dealer</option>
      <option value="Dual registrant — Registered Investment Adviser (RIA) and Broker-Dealer">Dual Registration</option>
    </select>
  </div>

  {/* Data Source Disclosure */}
  <div>
    <label className="block font-medium mb-1">
      Data Source Disclosure{" "}
      {data.private?.items?.length > 0 && (
        <span className="text-red-600 ml-1">*</span>
      )}
    </label>
    <textarea
      className={`border rounded w-full p-2 ${
        data.private?.items?.length > 0 &&
        !data.disclosure?.dataSourceDisclosure
          ? "border-red-400"
          : ""
      }`}
      placeholder="E.g. Private market data provided by advisor; not independently verified."
      value={data.disclosure?.dataSourceDisclosure || ""}
      onChange={(e) =>
        setData({
          ...data,
          disclosure: {
            ...data.disclosure,
            dataSourceDisclosure: e.target.value,
          },
        })
      }
    />
    {data.private?.items?.length > 0 &&
      !data.disclosure?.dataSourceDisclosure && (
        <p className="text-xs text-red-600 mt-1">
          Required when private market data is uploaded.
        </p>
      )}
  </div>

  {/* Optional Extra Note */}
  <div>
    <label className="block font-medium mb-1">Optional Extra Note</label>
    <textarea
      className="border rounded w-full p-2"
      placeholder="Any additional advisor-level disclosure (optional)"
      value={data.disclosure?.customDisclaimer || ""}
      onChange={(e) =>
        setData({
          ...data,
          disclosure: {
            ...data.disclosure,
            customDisclaimer: e.target.value,
          },
        })
      }
    />
  </div>
</section>


      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={save}
          disabled={!hasUnsaved}
          className={`px-3 py-2 text-white rounded ${hasUnsaved ? 'bg-blue-600' : 'bg-gray-400 cursor-not-allowed'}`}
          title={hasUnsaved ? 'Save changes' : 'No changes to save'}
        >
          Save
        </button>
        <button
          className="px-3 py-2 bg-gray-200 rounded"
          onClick={() => {
            if (!lastSaved) return;
            setData(d => ({ ...lastSaved, private: d.private }));
            setChartCsv(toCSV(lastSaved.positions.chart));
            setSummaryCsv(toCSV(lastSaved.positions.summary));
          }}
          disabled={!hasUnsaved}
          title="Revert to last saved"
        >
          Discard changes
        </button>
        {error && <div className="text-red-600">{error}</div>}
        {savedMsg && <div className="text-green-600">{savedMsg}</div>}
      </div>
    </main>
    );
  }
