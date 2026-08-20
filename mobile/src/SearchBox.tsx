import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  buildSearchSuggestions,
  highlightSegments,
  type SearchDrill,
  type SearchHit,
  type SearchableSession,
} from "./searchMatch";

type Props = {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  sessions: SearchableSession[];
  clientLabels: Record<string, string>;
  onPickSession: (client: string, sessionId: string) => void;
  onPickDrill: (drill: SearchDrill) => void;
  inputClassName?: string;
};

function HitLabel({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightSegments(text, query).map((seg, i) =>
        seg.on ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>
      )}
    </>
  );
}

export default function SearchBox({
  value,
  onChange,
  placeholder,
  sessions,
  clientLabels,
  onPickSession,
  onPickDrill,
  inputClassName = "search",
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 320 });

  const groups = useMemo(
    () => buildSearchSuggestions(sessions, value, clientLabels),
    [sessions, value, clientLabels]
  );
  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);

  const show = open && value.trim().length > 0;

  function placeMenu() {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.max(320, r.width);
    let left = r.right - width;
    if (left < 8) left = 8;
    if (left + width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - width - 8);
    }
    setMenuPos({ top: r.bottom + 6, left, width });
  }

  useEffect(() => {
    if (!show) return;
    placeMenu();
    const onWin = () => placeMenu();
    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true);
    return () => {
      window.removeEventListener("resize", onWin);
      window.removeEventListener("scroll", onWin, true);
    };
  }, [show, value]);

  useEffect(() => {
    setActive(0);
  }, [value]);

  useEffect(() => {
    if (!show) return;
    const el = menuRef.current?.querySelector(".search-hit.active");
    el?.scrollIntoView({ block: "nearest" });
  }, [active, show]);

  useEffect(() => {
    function onHotkey(e: globalThis.KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
      setOpen(true);
      placeMenu();
    }
    window.addEventListener("keydown", onHotkey);
    return () => window.removeEventListener("keydown", onHotkey);
  }, []);

  function pick(hit: SearchHit) {
    if (hit.action.type === "drill") {
      onPickDrill(hit.action.drill);
      setOpen(false);
      return;
    }
    onPickSession(hit.action.client, hit.action.sessionId);
    setOpen(false);
  }

  function clear() {
    onChange("");
    setOpen(false);
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing || e.key === "Process") return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (show) {
        setOpen(false);
        return;
      }
      if (value) clear();
      return;
    }
    if (!show || flat.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      const hit = flat[active];
      if (hit) {
        e.preventDefault();
        pick(hit);
      }
    }
  }

  let cursor = 0;

  const menu = show
    ? createPortal(
        <div
          ref={menuRef}
          id="token-stats-search-menu"
          className="search-menu"
          role="listbox"
          style={{
            top: menuPos.top,
            left: menuPos.left,
            width: menuPos.width,
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {groups.length === 0 ? (
            <div className="search-empty">无匹配</div>
          ) : (
            groups.map((g) => (
              <div key={g.group} className="search-group" role="group" aria-label={g.title}>
                <div className="search-group-title">{g.title}</div>
                {g.hits.map((hit) => {
                  const idx = cursor++;
                  const on = idx === active;
                  return (
                    <button
                      key={hit.id}
                      type="button"
                      role="option"
                      aria-selected={on}
                      className={`search-hit${on ? " active" : ""}`}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => pick(hit)}
                    >
                      <span className="search-hit-label">
                        <HitLabel text={hit.label} query={value} />
                      </span>
                      {hit.hint ? (
                        <span className="search-hit-hint">{hit.hint}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>,
        document.body
      )
    : null;

  return (
    <div className="search-wrap">
      <input
        ref={inputRef}
        className={inputClassName}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          placeMenu();
        }}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={show}
        aria-autocomplete="list"
        aria-controls="token-stats-search-menu"
      />
      {value ? (
        <button
          type="button"
          className="search-clear"
          aria-label="清除搜索"
          title="清除"
          onMouseDown={(e) => e.preventDefault()}
          onClick={clear}
        >
          ×
        </button>
      ) : null}
      {menu}
    </div>
  );
}
