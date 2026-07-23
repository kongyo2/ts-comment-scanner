/* Progressive enhancement only: the page is fully readable without this. */

(() => {
  const root = document.documentElement;

  /* ------------------------------------------------------ language toggle */
  const applyLang = (lang) => {
    root.dataset.lang = lang;
    root.lang = lang;
    document.querySelectorAll("[data-set-lang]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.setLang === lang));
    });
  };

  const fromUrl = new URLSearchParams(location.search).get("lang");
  let stored = null;
  try {
    stored = localStorage.getItem("tcs-lang");
  } catch {
    /* storage may be unavailable; keep the default */
  }
  const pick = (value) => (value === "ja" || value === "en" ? value : null);
  const initial =
    pick(fromUrl) ?? pick(stored) ?? ((navigator.language || "").toLowerCase().startsWith("ja") ? "ja" : "en");
  applyLang(initial);

  document.querySelectorAll("[data-set-lang]").forEach((button) => {
    button.addEventListener("click", () => {
      applyLang(button.dataset.setLang);
      try {
        localStorage.setItem("tcs-lang", button.dataset.setLang);
      } catch {
        /* best effort */
      }
    });
  });

  /* --------------------------------------------------------- copy buttons */
  document.querySelectorAll(".copy-btn[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        button.classList.add("copied");
        button.textContent = "copied";
        setTimeout(() => {
          button.classList.remove("copied");
          button.textContent = "copy";
        }, 1600);
      } catch {
        /* clipboard unavailable (e.g. http): leave the button as-is */
      }
    });
  });

  /* ------------------------------------------- seamless ticker duplication */
  document.querySelectorAll(".ticker-track").forEach((track) => {
    track.append(...[...track.children].map((chip) => chip.cloneNode(true)));
  });
})();
