import type { Provider } from "../db/index.js";

export interface CalendarEvent {
  id: string;
  provider: Provider;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
}

export interface EventInput {
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
  description?: string;
}

export interface CalendarClient {
  provider: Provider;
  listEvents(from: Date, to: Date): Promise<CalendarEvent[]>;
  createEvent(input: EventInput): Promise<CalendarEvent>;
  updateEvent(id: string, input: Partial<EventInput>): Promise<CalendarEvent>;
  deleteEvent(id: string): Promise<void>;
}
