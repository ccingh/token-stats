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

  function pick(hit: SearchHit) {
    if (hit.action.type === "drill") {
      onPickDrill(hit.action.drill);
      setOpen(false);
      return;
    }
    onPickSession(hit.action.client, hit.action.sessionId);
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      if (show) {
        e.preventDefault();
        setOpen(false);
      }
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
          className="search-menu"
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
              <div key={g.group} className="search-group">
                <div className="search-group-title">{g.title}</div>
                {g.hits.map((hit) => {
                  const idx = cursor++;
                  const on = idx === active;
                  return (
                    <button
                      key={hit.id}
                      type="button"
                      className={`search-hit${on ? " active" : ""}`}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => pick(hit)}
                    >
                      <span className="search-hit-label">{hit.label}</span>
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
      />
      {menu}
    </div>
  );
}
