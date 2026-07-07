const list = document.getElementById("sourcesList");
const template = document.getElementById("sourceTemplate");
const shareAudioInput = document.getElementById("shareAudioInput");
const audioRow = document.getElementById("audioRow");
const cancelButton = document.getElementById("cancelButton");
const refreshButton = document.getElementById("refreshButton");
const emptyState = document.getElementById("emptyState");
const tabs = Array.from(document.querySelectorAll(".source-tab"));

let allSources = [];
let platformName = "";
let activeFilter = "window";

cancelButton.addEventListener("click", () => window.vlanyaPicker.cancel());

const filterSources = () => {
  if (activeFilter === "all") return allSources;
  return allSources.filter((source) => source.type === activeFilter);
};

const updateTabs = () => {
  const counts = {
    window: allSources.filter((source) => source.type === "window").length,
    screen: allSources.filter((source) => source.type === "screen").length,
    all: allSources.length,
  };

  for (const tab of tabs) {
    const filter = tab.dataset.filter;
    tab.classList.toggle("is-active", filter === activeFilter);
    const base = filter === "window" ? "Окна" : filter === "screen" ? "Экраны" : "Все";
    tab.textContent = `${base} ${counts[filter] || 0}`;
  }
};

const updateEmptyState = (sources) => {
  if (sources.length) {
    emptyState.hidden = true;
    emptyState.textContent = "";
    return;
  }

  emptyState.hidden = false;
  if (activeFilter === "window") {
    emptyState.textContent = "Окна не найдены. Разверни нужное окно, убери его из трея и нажми «Обновить».";
  } else if (activeFilter === "screen") {
    emptyState.textContent = "Экраны не найдены. Попробуй нажать «Обновить».";
  } else {
    emptyState.textContent = "Нет источников для демонстрации. Попробуй нажать «Обновить».";
  }
};

const renderSources = () => {
  const sources = filterSources();
  list.innerHTML = "";
  updateTabs();
  updateEmptyState(sources);

  for (const source of sources) {
    const node = template.content.firstElementChild.cloneNode(true);
    const image = node.querySelector(".thumb");
    if (source.thumbnail) {
      image.src = source.thumbnail;
    } else {
      image.removeAttribute("src");
    }
    node.querySelector(".source-title").textContent = source.name;
    node.querySelector(".source-type").textContent = source.type === "screen" ? "Экран" : "Окно";
    node.addEventListener("click", () => {
      const canShareAudio = platformName === "win32";
      window.vlanyaPicker.choose({
        sourceId: source.id,
        shareAudio: canShareAudio && shareAudioInput.checked,
      });
    });
    list.append(node);
  }
};

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    activeFilter = tab.dataset.filter || "window";
    renderSources();
  });
}

refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  try {
    await window.vlanyaPicker.refresh();
  } finally {
    refreshButton.disabled = false;
  }
});

window.vlanyaPicker.onSources(({ sources, platform }) => {
  allSources = Array.isArray(sources) ? sources : [];
  platformName = platform;

  if (platform !== "win32") {
    shareAudioInput.checked = false;
    shareAudioInput.disabled = true;
    audioRow.querySelector("span").textContent = "Системный звук доступен только на Windows";
  }

  renderSources();
});
