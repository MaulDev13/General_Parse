const input = document.getElementById("inputText");
const result = document.getElementById("resultText");

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
});

// document.getElementById("parseButton").addEventListener("click", () => {
//     console.log("Parse button clicked");
//     result.value = input.value;
// });

document
    .getElementById("parseButton")
    .addEventListener("click", () => {

        try {

            const input = document.getElementById("inputText").value;

            const reviews = BatchexecuteParser.parse(input);

            document.getElementById("resultText").value =
                JSON.stringify(reviews, null, 2);

        }
        catch (err) {

            document.getElementById("resultText").value =
                err.message;

        }

    });