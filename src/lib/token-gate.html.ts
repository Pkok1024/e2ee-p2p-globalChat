export const TOKEN_GATE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>Access Required</title>
  <style>
    :root {
      --bg: #0d0f12;
      --surface: #14171c;
      --border: #23272f;
      --border-focus: #4ade80;
      --text: #e2e8f0;
      --text-muted: #64748b;
      --accent: #4ade80;
      --accent-dim: #166534;
      --danger: #f87171;
      --radius: 6px;
      --font-mono: "SFMono-Regular", "Consolas", "Liberation Mono", "Menlo", monospace;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 14px;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    body { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
    .card { width: 100%; max-width: 400px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 40px 36px 36px; }
    .icon-wrap { display: flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: 50%; background: var(--accent-dim); margin: 0 auto 24px; }
    .icon-wrap svg { display: block; width: 22px; height: 22px; fill: none; stroke: var(--accent); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    h1 { text-align: center; font-size: 15px; font-weight: 600; letter-spacing: 0.04em; color: var(--text); margin-bottom: 6px; }
    .subtitle { text-align: center; font-size: 12px; color: var(--text-muted); margin-bottom: 28px; }
    label { display: block; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px; }
    .input-row { display: flex; gap: 8px; margin-bottom: 12px; }
    input[type="password"] { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-family: var(--font-mono); font-size: 14px; padding: 10px 14px; outline: none; transition: border-color 0.15s; min-width: 0; }
    input[type="password"]:focus { border-color: var(--border-focus); }
    input[type="password"]:disabled { opacity: 0.5; cursor: not-allowed; }
    button[type="submit"] { flex-shrink: 0; background: var(--accent); border: none; border-radius: var(--radius); color: #0d0f12; font-family: var(--font-mono); font-size: 13px; font-weight: 700; letter-spacing: 0.04em; padding: 10px 18px; cursor: pointer; transition: opacity 0.15s; white-space: nowrap; }
    button[type="submit"]:hover { opacity: 0.88; }
    button[type="submit"]:active { opacity: 0.75; }
    button[type="submit"]:disabled { opacity: 0.4; cursor: not-allowed; }
    .hint { min-height: 18px; font-size: 12px; color: var(--text-muted); text-align: center; }
    .hint.error { color: var(--danger); }
    .hint.ok { color: var(--accent); }
    #countdown { display: none; align-items: center; justify-content: center; gap: 8px; margin-top: 16px; font-size: 12px; color: var(--text-muted); }
    #countdown.visible { display: flex; }
    #countdown-bar-wrap { width: 120px; height: 3px; background: var(--border); border-radius: 99px; overflow: hidden; }
    #countdown-bar { height: 100%; background: var(--accent-dim); width: 100%; transition: width 0.25s linear; }
  </style>
</head>
<body>
  <main>
    <div class="card" role="main">
      <div class="icon-wrap" aria-hidden="true">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <h1>Access Required</h1>
      <p class="subtitle">Enter your community token to continue.</p>
      <form id="form" method="POST" action="/verify-token" autocomplete="off" novalidate>
        <label for="token">Community Token</label>
        <div class="input-row">
          <input id="token" name="token" type="password" placeholder="••••••••••••" autocomplete="one-time-code" spellcheck="false" autofocus required />
          <button type="submit" id="submit-btn">Enter</button>
        </div>
        <p class="hint" id="hint" role="alert" aria-live="polite">%%HINT%%</p>
      </form>
      <div id="countdown" aria-live="polite">
        <span id="countdown-text">wait 0s</span>
        <div id="countdown-bar-wrap" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100">
          <div id="countdown-bar"></div>
        </div>
      </div>
    </div>
  </main>
  <script>
    (function () {
      "use strict";
      var form = document.getElementById("form");
      var input = document.getElementById("token");
      var btn = document.getElementById("submit-btn");
      var hint = document.getElementById("hint");
      var countdown = document.getElementById("countdown");
      var cdText = document.getElementById("countdown-text");
      var cdBar = document.getElementById("countdown-bar");
      var waitUntil = parseInt("%%WAIT_UNTIL%%", 10) || 0;
      var cdTimer = null;
      function setDisabled(dis) { input.disabled = dis; btn.disabled = dis; }
      function startCountdown(untilMs) {
        var total = untilMs - Date.now();
        if (total <= 0) return;
        setDisabled(true);
        countdown.classList.add("visible");
        function tick() {
          var remaining = untilMs - Date.now();
          if (remaining <= 0) {
            clearInterval(cdTimer);
            countdown.classList.remove("visible");
            cdBar.style.width = "100%";
            setDisabled(false);
            input.focus();
            return;
          }
          var secs = Math.ceil(remaining / 1000);
          cdText.textContent = "wait " + secs + "s";
          var pct = (remaining / total) * 100;
          cdBar.style.width = pct + "%";
          if (countdown.querySelector("[role='progressbar']")) {
            countdown.querySelector("[role='progressbar']").setAttribute("aria-valuenow", Math.round(pct));
          }
        }
        tick();
        cdTimer = setInterval(tick, 250);
      }
      if (waitUntil > Date.now()) startCountdown(waitUntil);
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var token = input.value.trim();
        if (!token) { hint.textContent = "Token cannot be empty."; hint.className = "hint error"; return; }
        setDisabled(true);
        hint.textContent = "Verifying...";
        hint.className = "hint";
        var body = new URLSearchParams();
        body.set("token", token);
        fetch("/verify-token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data.ok) {
              hint.textContent = "Access granted.";
              hint.className = "hint ok";
              window.location.href = data.redirect || "/";
            } else if (data.waitUntil) {
              hint.textContent = "Invalid token.";
              hint.className = "hint error";
              startCountdown(data.waitUntil);
            } else {
              hint.textContent = data.message || "Invalid token.";
              hint.className = "hint error";
              setDisabled(false);
              input.select();
            }
          })
          .catch(function () {
            hint.textContent = "Network error. Please retry.";
            hint.className = "hint error";
            setDisabled(false);
          });
      });
    })();
  </script>
</body>
</html>`;

export function renderGate(opts: { hint?: string; waitUntil?: number } = {}): string {
  return TOKEN_GATE_HTML
    .replace("%%HINT%%", opts.hint ?? "")
    .replace("%%WAIT_UNTIL%%", String(opts.waitUntil ?? 0));
}
