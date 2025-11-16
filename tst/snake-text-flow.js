// Store original text content
let originalText = null;

/**
 * Detects line breaks in rendered text and wraps each line in a span element.
 * Applies rotateY(180deg) transform to every other line for snake text flow.
 */
function applySnakeFlow() {
    const container = document.getElementById('textContainer');

    // Store original text if not already stored
    if (originalText === null) {
        originalText = container.textContent;
    }

    // Reset to original text
    container.textContent = originalText;

    // Detect lines by measuring word positions
    const lines = detectLines(container);

    // Clear container and rebuild with wrapped lines
    container.innerHTML = '';

    lines.forEach((lineText, index) => {
        const lineSpan = document.createElement('span');
        lineSpan.className = 'text-line';

        // Apply mirrored class to even-indexed lines (0-based: 1, 3, 5, etc.)
        if (index % 2 === 1) {
            lineSpan.classList.add('mirrored');
        }

        lineSpan.textContent = lineText;
        container.appendChild(lineSpan);
    });
}

/**
 * Detects where lines break naturally in the rendered text.
 * Returns an array of strings, one for each line.
 */
function detectLines(container) {
    const text = container.textContent.trim();
    const words = text.split(/(\s+)/); // Split but keep whitespace

    // Create temporary container with same styling
    const tempContainer = document.createElement('div');
    tempContainer.style.cssText = window.getComputedStyle(container).cssText;
    tempContainer.style.position = 'absolute';
    tempContainer.style.visibility = 'hidden';
    tempContainer.style.width = container.offsetWidth + 'px';
    document.body.appendChild(tempContainer);

    const lines = [];
    let currentLine = '';
    let lastY = null;

    // Process each word and detect when Y position changes
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const testText = currentLine + word;

        tempContainer.textContent = testText;

        // Create a range to measure the last word's position
        const range = document.createRange();
        const textNode = tempContainer.firstChild;

        if (textNode && textNode.nodeType === Node.TEXT_NODE) {
            const wordStart = currentLine.length;
            const wordEnd = testText.length;

            try {
                range.setStart(textNode, Math.min(wordStart, textNode.length));
                range.setEnd(textNode, Math.min(wordEnd, textNode.length));

                const rect = range.getBoundingClientRect();
                const currentY = rect.top;

                // If Y position changed, we have a new line
                if (lastY !== null && currentY !== lastY) {
                    // Save the previous line (without the current word)
                    lines.push(currentLine.trimEnd());
                    currentLine = word;
                } else {
                    currentLine = testText;
                }

                lastY = currentY;
            } catch (e) {
                // If range fails, just append the word
                currentLine = testText;
            }
        }
    }

    // Add the last line
    if (currentLine.trim()) {
        lines.push(currentLine.trimEnd());
    }

    // Clean up
    document.body.removeChild(tempContainer);

    return lines;
}

/**
 * Resets the text to its original state.
 */
function resetText() {
    const container = document.getElementById('textContainer');
    if (originalText !== null) {
        container.textContent = originalText;
    }
}

// Auto-apply on window resize to re-calculate line breaks
let resizeTimeout;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        if (originalText !== null) {
            applySnakeFlow();
        }
    }, 250);
});
