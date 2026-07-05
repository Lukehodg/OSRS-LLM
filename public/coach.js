/* PvM Coach — capture the player's shared game window, keep a rolling
   buffer of recent frames, and send a burst to the sage for analysis.
   Depends on window.WOM (from app.js) for rendering advice into the chat. */

(function () {
  const MAX_FRAMES = 6;         // matches the server cap
  const CAPTURE_EVERY_MS = 2000; // ~12s window across 6 frames
  const FRAME_MAX_WIDTH = 900;   // downscale to bound vision cost
  const JPEG_QUALITY = 0.7;

  const panel = document.getElementById("coach");
  const openBtn = document.getElementById("coach-open");
  const video = document.getElementById("coach-video");
  const idle = document.getElementById("coach-idle");
  const rec = document.getElementById("coach-rec");
  const statusEl = document.getElementById("coach-status");
  const noteEl = document.getElementById("coach-note");
  const shareBtn = document.getElementById("coach-share");
  const analyseBtn = document.getElementById("coach-analyse");
  const stopBtn = document.getElementById("coach-stop");

  const canvas = document.createElement("canvas");
  const cctx = canvas.getContext("2d");

  let stream = null;
  let captureTimer = null;
  const frames = []; // rolling buffer of data URLs

  const supported =
    !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  // -------------------------------------------------------------------------
  // Panel open/close
  // -------------------------------------------------------------------------
  function openPanel() {
    panel.hidden = false;
    if (!supported) {
      statusEl.textContent =
        "Screen sharing isn't available in this browser. Try Chrome, Edge or Firefox on desktop.";
      shareBtn.disabled = true;
    }
  }
  function closePanel() { panel.hidden = true; }

  openBtn.addEventListener("click", openPanel);
  panel.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-coach-dismiss")) closePanel();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) closePanel();
  });

  // -------------------------------------------------------------------------
  // Screen share
  // -------------------------------------------------------------------------
  async function startShare() {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 5 },
        audio: false,
      });
    } catch (err) {
      if (err && err.name === "NotAllowedError") {
        statusEl.textContent = "Screen share was cancelled.";
      } else {
        statusEl.textContent = "Couldn't start screen sharing.";
      }
      return;
    }

    video.srcObject = stream;
    await video.play().catch(() => {});
    idle.hidden = true;
    rec.hidden = false;
    frames.length = 0;

    // If the user stops sharing from the browser's own UI, reset cleanly.
    stream.getVideoTracks()[0].addEventListener("ended", stopShare);

    shareBtn.hidden = true;
    stopBtn.hidden = false;
    updateStatus();

    captureTimer = setInterval(captureFrame, CAPTURE_EVERY_MS);
    captureFrame(); // grab one immediately
  }

  function stopShare() {
    if (captureTimer) { clearInterval(captureTimer); captureTimer = null; }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    video.srcObject = null;
    idle.hidden = false;
    rec.hidden = true;
    shareBtn.hidden = false;
    stopBtn.hidden = true;
    frames.length = 0;
    refreshAnalyseState();
    statusEl.textContent = "Stopped watching.";
  }

  function captureFrame() {
    if (!stream || !video.videoWidth) return;
    const scale = Math.min(1, FRAME_MAX_WIDTH / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    cctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
    while (frames.length > MAX_FRAMES) frames.shift();
    updateStatus();
    refreshAnalyseState();
  }

  function updateStatus() {
    if (!stream) return;
    const secs = Math.min(frames.length, MAX_FRAMES) * (CAPTURE_EVERY_MS / 1000);
    statusEl.textContent =
      frames.length < 2
        ? "Watching — play for a few seconds to build up a clip…"
        : `Watching — ${frames.length} frames buffered (~${secs}s of play). Ready to analyse.`;
  }

  function refreshAnalyseState() {
    analyseBtn.disabled = !stream || frames.length < 2 || (window.WOM && window.WOM.busy);
  }

  // Keep the analyse button in sync with the sage being busy.
  setInterval(refreshAnalyseState, 500);

  // -------------------------------------------------------------------------
  // Analyse
  // -------------------------------------------------------------------------
  async function analyse() {
    if (!window.WOM || window.WOM.busy || frames.length < 2) return;
    const batch = frames.slice(-MAX_FRAMES);
    const note = noteEl.value.trim();
    const label = note
      ? `🎥 Analyse my gameplay — ${note}`
      : `🎥 Analyse my gameplay (${batch.length} frames)`;

    closePanel();
    await window.WOM.analyseFrames(batch, label);
    // Sharing keeps running so they can capture another clip and analyse again.
  }

  shareBtn.addEventListener("click", startShare);
  stopBtn.addEventListener("click", stopShare);
  analyseBtn.addEventListener("click", analyse);

  window.addEventListener("beforeunload", () => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  });
})();
