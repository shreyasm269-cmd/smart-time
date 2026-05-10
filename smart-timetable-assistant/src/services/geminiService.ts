import { GoogleGenAI, Type, FunctionDeclaration } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });

export const createEventTool: FunctionDeclaration = {
  name: "createEvent",
  description: "Create a new event in the user's schedule",
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "Title of the event" },
      type: { 
        type: Type.STRING, 
        enum: ["class", "exam", "study", "personal", "assignment_deadline"],
        description: "Type of event"
      },
      startTime: { type: Type.STRING, description: "ISO 8601 formatted start time" },
      endTime: { type: Type.STRING, description: "ISO 8601 formatted end time" },
      location: { type: Type.STRING, description: "Location of the event" },
      description: { type: Type.STRING, description: "Detailed description" },
      recurrence: {
        type: Type.OBJECT,
        properties: {
          frequency: { type: Type.STRING, enum: ["daily", "weekly", "monthly", "none"] },
          daysOfWeek: { type: Type.ARRAY, items: { type: Type.NUMBER }, description: "0-6 for Sun-Sat" },
          until: { type: Type.STRING, description: "ISO 8601 formatted end date for recurrence" }
        }
      }
    },
    required: ["title", "type", "startTime", "endTime"]
  }
};

export const createAssignmentTool: FunctionDeclaration = {
  name: "createAssignment",
  description: "Add a new assignment to the tracking list",
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "Assignment title" },
      subject: { type: Type.STRING, description: "Subject or course name" },
      dueDate: { type: Type.STRING, description: "ISO 8601 formatted due date" },
      priority: { type: Type.STRING, enum: ["low", "medium", "high"] },
      description: { type: Type.STRING, description: "Assignment details" },
    },
    required: ["title", "dueDate"]
  }
};

export async function chatWithAssistant(messages: any[], context: string) {
  const systemInstruction = `You are a Smart Timetable Assistant AI named SmartFlow. 
  Your primary objective is to manage the user's academic and personal schedule with precision.
  
  CURRENT_TIMESTAMP: ${new Date().toISOString()}
  USER_CONTEXT:
  ${context}
  
  CORE CAPABILITIES:
  1. ADAPTIVE SCHEDULING: When asked to "Auto-Schedule" or "Optimize", look at the existing 'events' and 'assignments' in the context. Find gaps of at least 1 hour during standard study hours (08:00 - 22:00).
  2. PRIORITIZATION: Schedule study sessions for HIGH priority assignments first.
  3. CONFLICT DETECTION: If a user manual request conflicts with an existing event, warn them but offer to reschedule.
  4. ASSIGNMENT TRACKING: Track due dates and ensure study sessions are scheduled AT LEAST 24 hours before the deadline.
  5. RECURRING EVENTS: Can schedule recurring classes or personal routines (e.g., "Every Monday and Wednesday at 10am").

  RULES:
  - Do not create overlapping events.
  - Use 'createEvent' for study sessions (type: 'study').
  - When auto-scheduling, create between 2-4 study blocks depending on the workload.
  - For recurring events, always specify 'recurrence' with frequency and optionally daysOfWeek and until.
  - Keep descriptions concise and helpful.
  `;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: messages,
    config: {
      systemInstruction,
      tools: [{ functionDeclarations: [createEventTool, createAssignmentTool] }]
    }
  });

  const text = response.text || "";
  const functionCalls = response.functionCalls || [];

  return { text, functionCalls };
}
