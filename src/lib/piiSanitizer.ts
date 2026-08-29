// Thin gateway — PII sanitization removed. All functions are pass-throughs.

export const sanitizePII = (text: string): string => text;

export const sanitizePIIChunk = (chunk: string): string => chunk;

export const sanitizePIIResponse = (response: any): any => response;
