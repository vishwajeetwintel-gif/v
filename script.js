const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const resetBtn = document.getElementById('reset-btn');
const forceBtn = document.getElementById('force-btn');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const visualizer = document.getElementById('visualizer');

const transcriptContent = document.getElementById('transcript-content');
const activeQuestionBox = document.getElementById('active-question-box');
const activeQuestionText = document.getElementById('active-question-text');
const aiAnswerContent = document.getElementById('ai-answer-content');

let stream = null;
let mediaRecorder = null;
let recordingInterval = null;
let isRecording = false;

// We will maintain a running buffer of recognized text to find questions
let transcriptBuffer = "";

// Time per chunk (4 seconds for near real-time transcripts)
const CHUNK_DURATION_MS = 4000;

// Silence-Based Triggering (Smart Debounce)
// Only analyze the question after 5 seconds of silence
let silenceTimer = null;
const SILENCE_TIMEOUT = 5000; 

startBtn.addEventListener('click', async () => {
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'monitor' },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      alert('No audio track found. Please ensure you checked "Share system audio".');
      stopCapture();
      return;
    }

    const audioStream = new MediaStream([audioTracks[0]]);
    stream.getVideoTracks()[0].onended = () => stopCapture();

    startRecording(audioStream);

    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusDot.classList.add('active');
    visualizer.classList.remove('hidden');
    statusText.textContent = 'Live Capture Active';
    
    // Clear welcomes
    transcriptContent.innerHTML = '';
    isRecording = true;

  } catch (err) {
    console.error('Error starting screen share:', err);
    alert('Could not start screen share: ' + err.message);
  }
});

stopBtn.addEventListener('click', stopCapture);

function startRecording(audioStream) {
  setupRecorder(audioStream);
  
  recordingInterval = setInterval(() => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      mediaRecorder.start();
    }
  }, CHUNK_DURATION_MS);
}

function setupRecorder(audioStream) {
  const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
  mediaRecorder = new MediaRecorder(audioStream, { mimeType });

  mediaRecorder.ondataavailable = async (e) => {
    if (e.data && e.data.size > 0 && isRecording) {
      await processAudioChunk(e.data);
    }
  };

  mediaRecorder.start();
}

function stopCapture() {
  isRecording = false;

  if (recordingInterval) {
    clearInterval(recordingInterval);
    recordingInterval = null;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }

  startBtn.disabled = false;
  stopBtn.disabled = true;
  statusDot.classList.remove('active');
  visualizer.classList.add('hidden');
  statusText.textContent = 'Standby';
}

resetBtn.addEventListener('click', () => {
  // Clear the AI's memory buffer
  transcriptBuffer = "";
  
  // Clear the UI logs
  transcriptContent.innerHTML = `
    <div class="welcome-msg">
      <p>Session cleared.</p>
      <p class="subtext">Capturing english continuously. Smart detection enabled.</p>
    </div>
  `;
  
  // Clear the AI panel
  activeQuestionBox.classList.add('hidden');
  aiAnswerContent.innerHTML = `
    <div class="waiting-state">
      <svg class="radar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="10"></circle>
        <circle cx="12" cy="12" r="6"></circle>
        <circle cx="12" cy="12" r="2"></circle>
      </svg>
      <p>Scanning transcription for full questions...</p>
    </div>
  `;
});

forceBtn.addEventListener('click', async () => {
  if (!transcriptBuffer || transcriptBuffer.trim() === "") {
    alert("No active audio captured yet. Start speaking first!");
    return;
  }
  
  // Create a loading state in the AI panel
  aiAnswerContent.innerHTML = `
    <div class="waiting-state">
      <svg class="radar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="10"></circle>
        <circle cx="12" cy="12" r="6"></circle>
        <circle cx="12" cy="12" r="2"></circle>
      </svg>
      <p>Force generating response...</p>
    </div>
  `;

  try {
    const response = await fetch('/force-answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcriptHistory: transcriptBuffer })
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const result = await response.json();
    
    if (result.ignore) {
      console.log("Hallucination detected. Ignoring.");
      // Reset the waiting state if it was forced
      if (aiAnswerContent.querySelector('.waiting-state')) {
         aiAnswerContent.innerHTML = `
          <div class="waiting-state">
            <svg class="radar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="10"></circle>
              <circle cx="12" cy="12" r="6"></circle>
              <circle cx="12" cy="12" r="2"></circle>
            </svg>
            <p>Scanning transcription for full questions...</p>
          </div>
        `;
      }
      return;
    }

    // Check if the backend auto-corrected the question, otherwise default
    const displayQuestion = result.question ? result.question : "Manual Response Triggered";
    renderSmartAnswer(displayQuestion, result.answer);
    
    // Clear buffer after forcing answer
    transcriptBuffer = "";
    
  } catch (error) {
    console.error('Error forcing answer:', error);
    aiAnswerContent.innerHTML = `<p style="color:var(--danger)">Failed to force sequence: ${error.message}</p>`;
  }
});

async function processAudioChunk(blob) {
  const formData = new FormData();
  formData.append('audio', blob, 'chunk.webm');

  try {
    const response = await fetch('/transcribe', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    const textChunk = data.transcript ? data.transcript.trim() : '';
    
    // Aggressive filtering for common Whisper silence hallucinations
    const isHallucination = 
      textChunk.includes('[BLANK_AUDIO]') ||
      textChunk.toLowerCase().includes('sites.google.com') ||
      textChunk.toLowerCase().includes('fema.gov') ||
      textChunk.toLowerCase().includes('amara.org') ||
      textChunk.toLowerCase().includes('please see the interview transcript') ||
      textChunk.toLowerCase().includes('thanks for watching') ||
      textChunk.toLowerCase().includes('thank you for watching') ||
      textChunk.toLowerCase().includes('subscribe') ||
      textChunk.toLowerCase().match(/^you$/); // Sometimes output is just the word "you"

    // Only proceed if Whisper heard something substantial and it's not a hallucination
    if (textChunk.length > 5 && !isHallucination) {
      addTranscriptStream(textChunk);
      
      // Append to rolling buffer
      transcriptBuffer += " " + textChunk;
      
      // RESET SILENCE TIMER: We only trigger analysis after the speaker stops for SILENCE_TIMEOUT
      if (silenceTimer) clearTimeout(silenceTimer);
      
      silenceTimer = setTimeout(async () => {
        if (transcriptBuffer.trim().length > 10) {
          console.log("[Silence Detected] Triggering analysis...");
          await analyzeBufferForQuestion(transcriptBuffer);
        }
      }, SILENCE_TIMEOUT);
    }
  } catch (error) {
    console.error('Error processing audio chunk:', error);
  }
}

async function analyzeBufferForQuestion(historyText) {
  try {
    const response = await fetch('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcriptHistory: historyText })
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const result = await response.json();
    
    if (result.ignore) {
      console.log("Hallucination detected by analyzer. Ignoring.");
      return;
    }

    // If the LLM determined a full interview question was asked
    if (result.is_full_question && result.question && result.answer) {
      console.log("Found a full question!", result.question);
      
      // 1. Display it
      renderSmartAnswer(result.question, result.answer);
      
      // 2. Clear the buffer so we don't keep answering the same question
      transcriptBuffer = "";
    } else {
      console.log("No complete question detected yet... waiting for more context.");
    }
    
  } catch (error) {
    console.error('Error analyzing buffer:', error);
  }
}

// ---- UI Helpers ----

function addTranscriptStream(text) {
  // Mark previous entries as stale
  const existingEntries = document.querySelectorAll('.log-entry');
  existingEntries.forEach(el => {
    el.classList.remove('latest');
    el.classList.add('stale');
  });

  const p = document.createElement('p');
  p.className = 'log-entry latest';
  p.textContent = text;
  
  transcriptContent.appendChild(p);
  transcriptContent.scrollTop = transcriptContent.scrollHeight;
  
  // Keep only the last 15 chunks in the UI so it doesn't lag indefinitely
  if (transcriptContent.children.length > 15) {
     transcriptContent.removeChild(transcriptContent.firstChild);
  }
}

function renderSmartAnswer(questionStr, markdownAnswer) {
  // Show the bold question box
  activeQuestionBox.classList.remove('hidden');
  activeQuestionText.textContent = questionStr;
  
  // Clear the existing content
  aiAnswerContent.innerHTML = '';
  
  // Create an invisible container for the parsed HTML
  const tempDiv = document.createElement('div');
  
  const lines = markdownAnswer.split('\n');
  let currentUl = null;
  
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    
    if (line.startsWith('-') || line.startsWith('*')) {
      if (!currentUl) {
        currentUl = document.createElement('ul');
        currentUl.className = 'ai-bullet-list';
        tempDiv.appendChild(currentUl);
      }
      const li = document.createElement('li');
      let cleanText = line.substring(1).trim();
      cleanText = cleanText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      li.innerHTML = cleanText;
      currentUl.appendChild(li);
    } else {
      currentUl = null; // reset list context
      const p = document.createElement('p');
      p.innerHTML = line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      p.style.marginBottom = '1rem';
      p.style.color = 'var(--text-muted)';
      tempDiv.appendChild(p);
    }
  }

  // Typewriter Animation Logic
  const allElements = Array.from(tempDiv.children);
  
  async function typeWriter() {
    for (let el of allElements) {
      if (el.tagName === 'UL') {
        const ulList = document.createElement('ul');
        ulList.className = 'ai-bullet-list';
        aiAnswerContent.appendChild(ulList);
        
        for (let li of Array.from(el.children)) {
          const newLi = document.createElement('li');
          newLi.style.opacity = '0';
          newLi.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
          newLi.style.transform = 'translateX(10px)';
          newLi.innerHTML = li.innerHTML;
          ulList.appendChild(newLi);
          
          await new Promise(r => setTimeout(r, 150)); // typing delay per bullet
          
          requestAnimationFrame(() => {
            newLi.style.opacity = '1';
            newLi.style.transform = 'translateX(0)';
            aiAnswerContent.scrollTop = aiAnswerContent.scrollHeight;
          });
        }
      } else {
        const newEl = document.createElement(el.tagName);
        newEl.style.cssText = el.style.cssText;
        newEl.style.opacity = '0';
        newEl.style.transition = 'opacity 0.3s ease';
        newEl.innerHTML = el.innerHTML;
        aiAnswerContent.appendChild(newEl);
        
        await new Promise(r => setTimeout(r, 100)); // typing delay per paragraph
        
        requestAnimationFrame(() => {
          newEl.style.opacity = '1';
          aiAnswerContent.scrollTop = aiAnswerContent.scrollHeight;
        });
      }
    }
  }
  
  typeWriter();
}
