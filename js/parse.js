const input = document.getElementById("inputText");
const result = document.getElementById("resultText");
const resultTree = document.getElementById("resultTree");

document.getElementById("loadSample1").addEventListener("click", () => {
    console.log("Load Sample 1 clicked");
    input.value = "Sample 1 content";
});

document.getElementById("loadSample2").addEventListener("click", () => {
    console.log("Load Sample 2 clicked");
    input.value = "Sample 2 content";
});

document.getElementById("clearData").addEventListener("click", () => {
    console.log("Clear Data clicked");
    input.value = "";
    result.value = "";
    resultTree.innerHTML = "";
});

document.getElementById("downloadJson").addEventListener("click", () => {

    const text = result.value.trim();

    if (!text) {
        alert("Belum ada hasil parse untuk diunduh.");
        return;
    }

    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-");

    const a = document.createElement("a");
    a.href = url;
    a.download = `parse-result-${timestamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    URL.revokeObjectURL(url);
});

document
    .getElementById("parseButton")
    .addEventListener("click", () => {

        try {

            const input = document.getElementById("inputText").value;

            const reviews = ParseEngine.parse(input);

            document.getElementById("resultText").value =
                JSON.stringify(reviews, null, 2);

            ParseRenderer.render(reviews, resultTree);

        }
        catch (err) {

            document.getElementById("resultText").value =
                err.message;

            resultTree.innerHTML = "";

        }

    });