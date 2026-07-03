const list = document.getElementById("sourcesList");
const template = document.getElementById("sourceTemplate");
const shareAudioInput = document.getElementById("shareAudioInput");
const audioRow = document.getElementById("audioRow");
const cancelButton = document.getElementById("cancelButton");

cancelButton.addEventListener("click", () => window.vlanyaPicker.cancel());

window.vlanyaPicker.onSources(({ sources, platform }) => {
  list.innerHTML = "";
  if (platform !== "win32") {
    shareAudioInput.checked = false;
    shareAudioInput.disabled = true;
    audioRow.querySelector("span").textContent = "Системный звук доступен только на Windows";
  }

  for (const source of sources) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector(".thumb").src = source.thumbnail;
    node.querySelector(".source-title").textContent = source.name;
    node.querySelector(".source-type").textContent = source.type === "screen" ? "Экран" : "Окно";
    node.addEventListener("click", () => {
      window.vlanyaPicker.choose({
        sourceId: source.id,
        shareAudio: shareAudioInput.checked,
      });
    });
    list.append(node);
  }
});
