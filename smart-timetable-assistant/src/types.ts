export type EventType = "class" | "exam" | "study" | "personal" | "assignment_deadline" | "other";
export type AssignmentStatus = "todo" | "in_progress" | "completed";
export type Priority = "low" | "medium" | "high";

export interface ScheduleEvent {
  id?: string;
  title: string;
  type: EventType;
  startTime: string;
  endTime: string;
  location?: string;
  description?: string;
  color?: string;
  relatedAssignmentId?: string;
  recurrence?: {
    frequency: 'daily' | 'weekly' | 'monthly' | 'none';
    daysOfWeek?: number[]; // 0-6
    until?: string;
  };
}

export interface Assignment {
  id?: string;
  title: string;
  subject: string;
  dueDate: string;
  priority: Priority;
  status: AssignmentStatus;
  description?: string;
}

export interface UserPreferences {
  dailyStartHour: number;
  dailyEndHour: number;
  defaultStudyDuration: number;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName?: string;
  preferences?: UserPreferences;
}

export interface ChatMessage {
  id?: string;
  text: string;
  role: "user" | "model" | "system";
  timestamp: string;
}
