import { useEffect, useRef, useState } from "react";
import logo from "./assets/logo.png";

// Every audio file dropped into src/sounds becomes a button, named after the file.
const files = import.meta.glob("./sounds/*.{mp3,ogg,wav,m4a}", { eager: true, query: "?url", import: "default" });

function makeSound(id, name, url, views = null) {
  const audio = new Audio(url);
  return { id, name, url, audio, views };
}

const STAR_VIEWS = 10_000;

const fromServer = (s) => makeSound(s.id, s.name, `/uploads/${s.file}`, s.views);

const BUNDLED = Object.entries(files)
  .map(([path, url]) => makeSound(path, path.split("/").pop().replace(/\.[^.]+$/, ""), url))
  .sort((a, b) => a.name.localeCompare(b.name));

const INTRO = BUNDLED.find((s) => s.name === "Hub Intro Sound");
let introStarted = false;

const COLORS = ["#e53935", "#fb8c00", "#fdd835", "#43a047", "#00acc1", "#1e88e5", "#5e35b1", "#d81b60", "#6d4c41", "#546e7a"];

const formatViews = (n) => new Intl.NumberFormat("en", { notation: "compact" }).format(n);

function SoundButton({ name, color, views, onPlay }) {
  const [pulse, setPulse] = useState(0);

  return (
    <div className="sound">
      <button
        type="button"
        className="sound-btn"
        style={{ "--c": color }}
        aria-label={`Play ${name}`}
        onClick={() => {
          onPlay();
          setPulse((n) => n + 1);
        }}
      >
        {pulse > 0 && <span key={pulse} className="ring" />}
      </button>
      <span className="sound-name">{name}</span>
      {views !== null && <span className="sound-views">{formatViews(views)} views</span>}
    </div>
  );
}

export default function App() {
  const [query, setQuery] = useState("");
  const [uploads, setUploads] = useState([]);
  const [error, setError] = useState("");
  const [visits, setVisits] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [file, setFile] = useState(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState(false);
  const playing = useRef(new Set());

  useEffect(() => {
    if (!INTRO || introStarted) return;
    introStarted = true;

    INTRO.audio.play().then(
      () => playing.current.add(INTRO.audio),
      () => setGate(true) // browsers block sound until the visitor clicks something
    );
  }, []);

  function enter() {
    setGate(false);
    INTRO.audio.play().then(() => playing.current.add(INTRO.audio));
  }

  useEffect(() => {
    fetch("/api/visit", { method: "POST" })
      .then((r) => r.json())
      .then(({ visits }) => setVisits(visits))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/sounds")
      .then((r) => r.json())
      .then((list) => setUploads(list.map(fromServer)))
      .catch(() => setError("Could not load shared sounds."));
  }, []);

  const q = query.trim().toLowerCase();
  const filter = (list) =>
    list
      .map((s, i) => ({ ...s, color: COLORS[i % COLORS.length] }))
      .filter((s) => s.name.toLowerCase().includes(q));
  const sections = [
    { title: "GoozStars", sounds: filter([...BUNDLED, ...uploads.filter((s) => s.views >= STAR_VIEWS)]) },
    { title: "Community", sounds: filter(uploads.filter((s) => s.views < STAR_VIEWS)) },
  ].filter((s) => s.sounds.length > 0);

  function play(sound) {
    sound.audio.currentTime = 0;
    sound.audio.play();
    playing.current.add(sound.audio);

    if (sound.views === null) return;
    fetch(`/api/sounds/${sound.id}/view`, { method: "POST" })
      .then((r) => r.json())
      .then(({ views }) => setUploads((prev) => prev.map((s) => (s.id === sound.id ? { ...s, views } : s))))
      .catch(() => {});
  }

  async function handleUpload(e) {
    e.preventDefault();
    const body = new FormData();
    body.append("name", name.trim());
    body.append("file", file);
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/sounds", { method: "POST", body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setUploads((prev) => [...prev, fromServer(data)]);
      closeForm();
    } catch (err) {
      setError(err.message || "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  function closeForm() {
    setShowForm(false);
    setFile(null);
    setName("");
  }

  function stopAll() {
    playing.current.forEach((a) => a.pause());
    playing.current.clear();
  }

  return (
    <>
      {gate && (
        <div className="overlay gate">
          <img className="gate-logo" src={logo} alt="GoozHub" />
          <button type="button" className="btn gate-btn" autoFocus onClick={enter}>
            Enter
          </button>
        </div>
      )}
      <header className="topbar">
        <img className="logo" src={logo} alt="GoozHub" />
        <div className="search">
          <input
            type="search"
            placeholder="Search sounds..."
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {visits !== null && (
          <div className="visits">
            how many people grazed the depths of this website: <strong>{visits.toLocaleString()}</strong>
          </div>
        )}
        <button type="button" className="btn" onClick={() => setShowForm(true)}>
          + Add sound
        </button>
      </header>

      {showForm && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && closeForm()}>
          <form className="modal" onSubmit={handleUpload}>
            <h2>Add a sound</h2>
            <label>
              Sound file
              <input
                type="file"
                accept=".mp3,.ogg,.wav,.m4a,audio/*"
                required
                onChange={(e) => {
                  const f = e.target.files[0] ?? null;
                  setFile(f);
                  if (f && !name) setName(f.name.replace(/\.[^.]+$/, "").slice(0, 60));
                }}
              />
            </label>
            <label>
              Name
              <input
                type="text"
                maxLength={60}
                required
                placeholder="Name your sound"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={closeForm}>
                Cancel
              </button>
              <button type="submit" className="btn" disabled={busy || !file || !name.trim()}>
                {busy ? "Uploading..." : "Upload"}
              </button>
            </div>
          </form>
        </div>
      )}

      <main>
        <h1>Instant Sound Buttons</h1>
        <p className="sub">Tap a button. Press again to restart it.</p>
        {error && <p className="error">{error}</p>}
        <button type="button" className="btn" onClick={stopAll}>
          Stop all
        </button>

        {sections.map(({ title, sounds }) => (
          <section key={title}>
            <h2 className="section-title">{title}</h2>
            <div className="grid">
              {sounds.map((s) => (
                <SoundButton key={s.id} name={s.name} color={s.color} views={s.views} onPlay={() => play(s)} />
              ))}
            </div>
          </section>
        ))}
        {sections.length === 0 && <p className="empty">No sounds found.</p>}
      </main>
    </>
  );
}
