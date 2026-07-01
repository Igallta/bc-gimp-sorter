// ==UserScript==
// @name         BC Gimp Sorter
// @namespace    https://igallta.github.io/bc-gimp-sorter
// @version      1.6.4
// @description  BC Gimp Doll 房间自动排序
// @match        https://www.bondage-europe.com/R129/BondageClub/*
// @match        https://www.bondageclub.com/R129/BondageClub/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
  "use strict";

  const allowedMemberNumber = 194331; // 御坂
  if (window.__GimpSorterLoaderStarted) return;
  window.__GimpSorterLoaderStarted = true;

  function loadScript() {
    if (typeof bcModSdk === "undefined") {
      setTimeout(loadScript, 500);
      return;
    }

    // 只有御坂账号加载，其他账号不受影响
    if (typeof Player === "undefined" || !(Player.MemberNumber || Player.ID)) {
      setTimeout(loadScript, 1000);
      return;
    }
    const memberNumber = Player.MemberNumber || Player.ID;
    if (memberNumber !== allowedMemberNumber) {
      console.log("[GimpSorter] skipped for member: " + memberNumber);
      return;
    }
    if (window.__GimpSorterLoaded || document.getElementById("gimp-sorter-script")) return;

    const script = document.createElement("script");
    script.id = "gimp-sorter-script";
    script.src = "https://igallta.github.io/bc-gimp-sorter/gimp-sorter.js?v=1.6.4";
    script.onload = () => console.log("[GimpSorter] loaded from GitHub Pages");
    script.onerror = () => console.error("[GimpSorter] failed to load from GitHub Pages");
    document.head.appendChild(script);
  }

  loadScript();
})();
