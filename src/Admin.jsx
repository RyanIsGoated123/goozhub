import { useEffect, useState } from "react";
import logo from "./assets/logo.png";

const KEY = "goozhub-admin-token";

export default function Admin() {
  const [token, setToken] = useState(() => sessionStorage.getItem(KEY));
  const [password, setPassword] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const headers = { Authorization: `Bearer ${token}` };

  function logout() {
    sessionStorage.removeItem(KEY);
    setToken(null);
    setData(null);
  }

  useEffect(() => {
    if (!token) return;
    fetch("/api/admin/stats", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (r.status === 401) {
          sessionStorage.removeItem(KEY);
          setToken(null);
          throw new Error("Session expired. Log in again.");
        }
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [token]);

  async function login(e) {
    e.preventDefault();
    setError("");
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      sessionStorage.setItem(KEY, body.token);
      setToken(body.token);
      setPassword("");
    } catch (err) {
      setError(err.message || "Login failed.");
    }
  }

  async function remove(sound) {
    if (!window.confirm(`Delete "${sound.name}"? This can't be undone.`)) return;
    setError("");
    const res = await fetch(`/api/admin/sounds/${sound.id}`, { method: "DELETE", headers });
    if (!res.ok) return setError((await res.json()).error || "Delete failed.");
    setData((d) => ({ ...d, sounds: d.sounds.filter((s) => s.id !== sound.id) }));
  }

  if (!token) {
    return (
      <div className="overlay">
        <form className="modal" onSubmit={login}>
          <img className="logo" src={logo} alt="GoozHub" />
          <h2>Admin</h2>
          <label>
            Password
            <input
              type="password"
              autoFocus
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <p className="error">{error}</p>}
          <div className="modal-actions">
            <button type="submit" className="btn">
              Log in
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <>
      <header className="topbar">
        <img className="logo" src={logo} alt="GoozHub" />
        <div className="search" />
        <a className="btn ghost" href="/">
          View site
        </a>
        <button type="button" className="btn" onClick={logout}>
          Log out
        </button>
      </header>

      <main>
        <h1>Admin</h1>
        {error && <p className="error">{error}</p>}
        {data && (
          <>
            <p className="sub">
              Site visits: <strong className="accent">{data.visits.toLocaleString()}</strong> · Uploaded sounds:{" "}
              <strong className="accent">{data.sounds.length}</strong>
            </p>
            {data.sounds.length === 0 ? (
              <p className="empty">No uploaded sounds.</p>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Views</th>
                    <th>Preview</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.sounds.map((s) => (
                    <tr key={s.id}>
                      <td>{s.name}</td>
                      <td>{s.views.toLocaleString()}</td>
                      <td>
                        <audio controls preload="none" src={`/uploads/${s.file}`} />
                      </td>
                      <td>
                        <button type="button" className="btn danger" onClick={() => remove(s)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </main>
    </>
  );
}
