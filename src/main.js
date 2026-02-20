/**
 * @license MIT
 * Logic & Architecture (c) 2024 FrCynda
 * * NOTE: This file contains "baked-in" legacy UI assets owned by Microsoft Corp.
 * These assets are used under Fair Use for educational/reconstruction purposes
 * and are NOT covered by the MIT license applied to the surrounding code.
 */

const { invoke } = window.__TAURI__.core;

let greetInputEl;
let greetMsgEl;

async function greet() {
  // Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
  greetMsgEl.textContent = await invoke("greet", { name: greetInputEl.value });
}

window.addEventListener("DOMContentLoaded", () => {
  greetInputEl = document.querySelector("#greet-input");
  greetMsgEl = document.querySelector("#greet-msg");
  document.querySelector("#greet-form").addEventListener("submit", (e) => {
    e.preventDefault();
    greet();
  });
});
