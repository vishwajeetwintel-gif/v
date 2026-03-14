require('dotenv').config({ override: true });
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Set up OpenAI Client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Configure Multer for audio uploads
const upload = multer({ dest: 'uploads/' });

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Serve frontend files securely
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/script.js', (req, res) => res.sendFile(path.join(__dirname, 'script.js')));

// /transcribe endpoint
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  console.log(`[POST /transcribe] Request received.`);
  try {
    if (!req.file) {
      console.warn(`[POST /transcribe] Error: No audio file provided.`);
      return res.status(400).json({ error: 'No audio file provided' });
    }

    console.log(`[POST /transcribe] Audio file received. Size: ${req.file.size} bytes. Original name: ${req.file.originalname}`);

    // OpenAI whisper expects a specific file extension, typically .webm or .wav 
    // depending on the media recorder format from frontend. Let's rename the file.
    const originalPath = req.file.path;
    const newPath = originalPath + '.webm';
    fs.renameSync(originalPath, newPath);

    console.log(`[POST /transcribe] Sending to Whisper API...`);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(newPath),
      model: 'whisper-1',
      language: 'en', // strictly enforce English translations
      prompt: 'This is an interview transcript. Please auto-correct spelling and grammar for professional software engineering terms. Do not transcribe silence. Do not generate fake subtitles about www.fema.gov or sites.google.com. If there is no speech, leave it blank.',
      temperature: 0, // Force lowest temperature so it doesn't get creative during silence
    });

    // Clean up temporary files
    fs.unlinkSync(newPath);

    res.json({ transcript: transcription.text });
  } catch (error) {
    console.error('Error in /transcribe:', error);
    res.status(500).json({ error: 'Failed to transcribe audio' });
  }
});

// /analyze endpoint (Smart Question Detection)
app.post('/analyze', async (req, res) => {
  console.log(`[POST /analyze] Request received.`);
  try {
    const { transcriptHistory } = req.body;

    if (!transcriptHistory || transcriptHistory.trim().length === 0) {
      return res.status(400).json({ error: 'Transcript history is required' });
    }

    console.log(`[POST /analyze] Analyzing history length: ${transcriptHistory.length} chars...`);

    // We ask ChatGPT to output JSON explicitly so we know if a question was found.
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: "json_object" },
      messages: [
        {
          role: 'system',
          content: `You are an elite, professional technical interview analysis engine. 
          
Listen to the provided transcript snippet. Your job is to determine if the speaker has finished asking a COMPLETE, identifiable interview question. 

If they have NOT finished asking a clear, COMPLETE question (e.g. they are in the middle of a sentence, paused, or the phrasing suggests more words are coming), return:
{"is_full_question": false, "question": null, "answer": null, "ignore": false}

If the transcript appears to be a hallucination (e.g., YouTube-style phrases like "thanks for watching", "subscribe", "thank you for listening", "we hope you enjoyed", "unrelated filler"), return:
{"is_full_question": false, "question": null, "answer": null, "ignore": true}

If they HAVE finished asking a clear interview question and it is grammatically complete, return:
{"is_full_question": true, "question": "The AUTO-CORRECTED, refined question (fix any transcription errors or misheard words based on context).", "answer": "The generated answer in natural, conversational human language.", "ignore": false}

STRICT COMPLETENESS RULES:
1. SCENARIO/SITUATION: If the input is describing a setup (e.g., "Imagine...", "There are...", "I have a situation..."), set is_full_question to FALSE unless the latest 2-3 words are an actual question (e.g., "...power it on?", "...do about it?", "...is the cause?").
2. CONJUNCTION CHECK: If the transcript ends with a conjunction (e.g., "and", "but", "or", "so", "if", "because") or a comma-like pause, it is NOT over. Set is_full_question to FALSE.
3. THE "ASK" REQUIREMENT: A valid interview question usually has a clear "Ask". If the transcript is just a list of facts or conditions without an "Ask", set is_full_question to FALSE.
4. STATEMENT VS QUESTION: Do not answer statements or descriptions. Wait for the question part.
5. Once a question is confirmed, auto-correct the "question" field to be a clean, professional summary of the entire scenario+question.
6. Provide the answer in natural, conversational human language.
7. Output valid JSON only.`,
        },
        {
          role: 'user',
          content: transcriptHistory,
        },
      ],
      temperature: 0.2, // low temp for analytical accuracy
    });

    const resultString = completion.choices[0].message.content;
    const resultObj = JSON.parse(resultString);
    
    console.log(`[POST /analyze] Detection Result: is_full_question = ${resultObj.is_full_question}`);

    res.json(resultObj);

  } catch (error) {
    console.error('Error in /analyze:', error);
    res.status(500).json({ error: 'Failed to analyze transcript' });
  }
});

// /force-answer endpoint (Manual override to just answer whatever is in the buffer)
app.post('/force-answer', async (req, res) => {
  console.log(`[POST /force-answer] Manual trigger received.`);
  try {
    const { transcriptHistory } = req.body;

    if (!transcriptHistory || transcriptHistory.trim().length === 0) {
       return res.status(400).json({ error: 'Data is required' });
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: "json_object" },
      messages: [
        {
          role: 'system',
          content: `You are an elite, professional technical interview AI assistant.
          
You must provide an answer to the following transcript text, even if it is fragmented or an incomplete question. Do your absolute best to deduce what they are talking about.

You must provide an answer to the following transcript text, even if it is fragmented or an incomplete question. Do your absolute best to deduce what they are talking about.

If the transcript appears to be a hallucination (e.g., YouTube-style phrases like "thanks for watching", "subscribe", "thank you for listening", "we hope you enjoyed", "unrelated filler"), return:
{"question": null, "answer": null, "ignore": true}

ANSWER GENERATION RULES:
1. Fix any transcription errors in the input and return the logically auto-corrected question in the "question" field.
2. Provide the "answer" in a natural, conversational, spoken-language style.
3. Do NOT use bullet points, lists, or formulaic introductions like "Here are some key points". Speak naturally as a human.
4. If the content is unrelated or hallucinated, set "ignore" to true.
5. Output valid JSON in the format: {"question": "Auto-corrected question.", "answer": "The answer.", "ignore": false} Only output JSON.`,
        },
        {
          role: 'user',
          content: transcriptHistory,
        },
      ],
      temperature: 0.5, // Slightly higher so it can guess fragmented hints
    });

    const resultString = completion.choices[0].message.content;
    const resultObj = JSON.parse(resultString);
    
    res.json(resultObj);

  } catch (error) {
    console.error('Error in /force-answer:', error);
    res.status(500).json({ error: 'Failed to force answer' });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
