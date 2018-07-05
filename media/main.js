// This script will be run within the webview itself
// It cannot access the main VS Code APIs directly.
(function () {
    const vscode = acquireVsCodeApi();
    const debugConsole = document.getElementById("debug-text");
    const debugInput = document.getElementById("debug-input");


    var lineBreakFlag = false;

    // Handle messages sent from the extension to the webview
    window.addEventListener('message', event => {
        const message = event.data; // The JSON data our extension sent

        switch (message.command) {
            case 'writeToConsole':
                writeToConsole(message.text);
                debugConsole.scrollTop = debugConsole.scrollHeight;
                break;
            case 'setConsoleText':
                setConsoleText(message.text);
                debugConsole.scrollTop = debugConsole.scrollHeight;
                break;
        }
    });

    document.getElementById("import-btn").addEventListener('click', function() {
        importFile();
    })

    document.getElementById("clear-btn").addEventListener('click', function() {
        setConsoleText("");
    })

    document.getElementById("export-btn").addEventListener('click', function() {
        exportLog();
    })



    function writeToConsole(text) {
        console.log("text is comming here::: " +text);
        debugConsole.textContent += text;
        return;

        let formatted = text;
        if (formatted.charAt(0) == "%") {
            lineBreakFlag = true;
            //formatted = formatted.replace("%", "\n%");
        }
        if (formatted.charAt(1) == "?" || formatted.charAt(0) == "?") {
            formatted += "\n";
        }
        if (lineBreakFlag) {
            if (formatted.trim() == "") {
                formatted = "\n" + formatted;
                lineBreakFlag = false;
            }
        }


    }

    function setConsoleText(text) {
        debugConsole.textContent = text;
    }

    debugInput.onkeypress = function(e){
        if (!e) e = window.event;
        var keyCode = e.keyCode || e.which;
        if (keyCode == '13'){
          //writeToConsole("you pressed enter");
          vscode.postMessage({ command: "user_input", text: debugInput.value})
          debugInput.value = "";
          console.log("pressed");
          return true;
        }
      }

      function importFile() {
        vscode.postMessage( {command: "importFile"});
      }

      function exportLog() {
        let raw = debugConsole.textContent;
        vscode.postMessage( {command: "exportLog", text: raw});
      }

      // on startup
      setConsoleText("");



}());