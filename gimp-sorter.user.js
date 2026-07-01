// ==UserScript==
// @name         BC Gimp Sorter
// @namespace    https://igallta.github.io/bc-gimp-sorter
// @version      1.3
// @description  BC Gimp Doll 房间自动排序
// @match        https://www.bondage-europe.com/R129/BondageClub/*
// @match        https://www.bondageclub.com/R129/BondageClub/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
  "use strict";

  function loadScript() {
    if (typeof bcModSdk === "undefined") {
      setTimeout(loadScript, 500);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://igallta.github.io/bc-gimp-sorter/gimp-sorter.js";
    script.onload = () => console.log("[GimpSorter] loaded from GitHub Pages");
    script.onerror = () => console.error("[GimpSorter] failed to load from GitHub Pages");
    document.head.appendChild(script);
  }

  loadScript();
})();