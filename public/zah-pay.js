/* =========================================================
   ZAH PAY, page script

   Load once, anywhere on the page:  <script src="/zah-pay/client.js"></script>

   It wires:
     [data-checkout="<package id>"]   opens Stripe Checkout for that package
     [data-checkout][data-plan="installments"]   the N-payment plan instead
     [data-book]                      href set to the booking URL from config

   When checkout is off (no key yet), a button opens a small note with the
   booking link and phone instead. The note takes its look from the host page
   through CSS variables, with plain fallbacks:

     --zp-bg, --zp-ink, --zp-muted, --zp-accent, --zp-accent-ink,
     --zp-line, --zp-radius, --zp-font, --zp-heading-font

   It never navigates a client who is in Zah Editor's edit mode.
   ========================================================= */
(function () {
  "use strict";
  if (window.ZahPay) return;

  var cfg = { payments: false, booking: "", phone: "", offMessage: "Online checkout is opening soon. Book a consultation and we will get you started." };

  var css = [
    ".zp-modal{position:fixed;inset:0;z-index:9000;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.5);backdrop-filter:blur(3px);font-family:var(--zp-font,system-ui,sans-serif)}",
    ".zp-modal.show{display:flex}",
    ".zp-box{background:var(--zp-bg,#fff);color:var(--zp-ink,#222);border-radius:var(--zp-radius,12px);max-width:440px;width:100%;padding:30px 28px;text-align:center;box-shadow:0 30px 60px rgba(0,0,0,.25);animation:zp-rise .35s cubic-bezier(.2,.8,.2,1)}",
    "@keyframes zp-rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}",
    ".zp-box h3{font-family:var(--zp-heading-font,var(--zp-font,system-ui,sans-serif));font-size:22px;margin:0 0 8px;font-weight:600}",
    ".zp-box p{font-size:14px;line-height:1.55;color:var(--zp-muted,#666);margin:0 0 18px}",
    ".zp-btn{display:block;width:100%;box-sizing:border-box;padding:12px 18px;border-radius:6px;font:600 14px var(--zp-font,system-ui,sans-serif);text-decoration:none;cursor:pointer;border:1px solid transparent}",
    ".zp-btn+.zp-btn{margin-top:8px}",
    ".zp-primary{background:var(--zp-accent,#222);color:var(--zp-accent-ink,#fff)}",
    ".zp-secondary{background:transparent;border-color:var(--zp-line,currentColor);color:var(--zp-ink,#222)}",
    ".zp-close{margin-top:14px;font:12px var(--zp-font,system-ui,sans-serif);color:var(--zp-muted,#666);background:none;border:0;cursor:pointer;text-decoration:underline}",
    ".zp-busy{opacity:.6;pointer-events:none}"
  ].join("");
  var style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);

  var modal = document.createElement("div");
  modal.className = "zp-modal"; modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
  modal.innerHTML = '<div class="zp-box"><h3 id="zp-title">Let\'s get you started</h3><p id="zp-text"></p>' +
    '<a class="zp-btn zp-primary" id="zp-book" target="_blank" rel="noopener">Book a Consultation</a>' +
    '<a class="zp-btn zp-secondary" id="zp-call"></a>' +
    '<button type="button" class="zp-close" id="zp-close">Not right now</button></div>';
  document.body.appendChild(modal);
  var elText = modal.querySelector("#zp-text"), elBook = modal.querySelector("#zp-book"), elCall = modal.querySelector("#zp-call");

  function applyCfg(c) {
    cfg = Object.assign(cfg, c || {});
    if (cfg.booking) {
      document.querySelectorAll("[data-book]").forEach(function (a) { a.href = cfg.booking; });
      elBook.href = cfg.booking; elBook.style.display = "";
    } else elBook.style.display = "none";
    if (cfg.phone) { elCall.textContent = "Call " + cfg.phone; elCall.href = "tel:" + cfg.phone.replace(/\D/g, ""); elCall.style.display = ""; }
    else elCall.style.display = "none";
  }
  fetch("/zah-pay/config").then(function (r) { return r.json(); }).then(applyCfg).catch(function () {});

  function open(text, extra) {
    elText.textContent = text || cfg.offMessage;
    if (extra) { if (extra.booking) { elBook.href = extra.booking; } if (extra.phone) { elCall.textContent = "Call " + extra.phone; elCall.href = "tel:" + extra.phone.replace(/\D/g, ""); } }
    modal.classList.add("show");
  }
  function close() { modal.classList.remove("show"); }
  modal.querySelector("#zp-close").addEventListener("click", close);
  modal.addEventListener("click", function (e) { if (e.target === modal) close(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });

  function checkout(packageId, plan, btn) {
    if (btn) btn.classList.add("zp-busy");
    return fetch("/zah-pay/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packageId: packageId, plan: plan || "full" }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (btn) btn.classList.remove("zp-busy");
        if (res.ok && res.d.url) { window.location.href = res.d.url; return true; }
        open(res.d.error, res.d); return false;
      })
      .catch(function () { if (btn) btn.classList.remove("zp-busy"); open("We could not reach checkout just now. Book a consultation or call us and we will get you started."); return false; });
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-checkout]");
    if (!btn) return;
    if (document.body.classList.contains("editing")) return;   // Zah Editor is open
    e.preventDefault();
    checkout(btn.getAttribute("data-checkout"), btn.getAttribute("data-plan") || "full", btn);
  });

  /** For a thank-you page: ZahPay.session(id) -> {paid, package, plan, email, amount, booking} */
  function session(id) {
    return fetch("/zah-pay/session?id=" + encodeURIComponent(id)).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "session"); return d; }); });
  }

  window.ZahPay = { checkout: checkout, open: open, close: close, session: session, config: function () { return cfg; } };
})();
