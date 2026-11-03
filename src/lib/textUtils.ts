/**
 * Text processing utilities for handling large payloads
 * Provides text chunking and validation to prevent 413 errors
 */

import {
  IOS_APP_BUILD,
  IOS_APP_VERSION_FALLBACK,
  IOS_OS_VERSION,
} from "./const";
import { PAYLOAD_LIMITS } from "./config";

/**
 * Estimate the payload size for a given text
 * @param text The text to estimate
 * @param sourceLang Source language
 * @param targetLang Target language
 * @returns Estimated payload size in bytes
 */
export function estimatePayloadSize(
  text: string,
  sourceLang: string = "auto",
  targetLang: string = "en"
): number {
  // Create a sample request structure to estimate size
  const sampleRequest = {
    text: [text],
    target_lang: targetLang,
    ...(sourceLang && sourceLang !== "auto" ? { source_lang: sourceLang } : {}),
    usage_type: "translate",
    app_information: {
      os: "iOS",
      os_version: IOS_OS_VERSION,
      app_version: IOS_APP_VERSION_FALLBACK,
      app_build: IOS_APP_BUILD,
      instance_id: "00000000-0000-4000-8000-000000000000",
    },
  };

  // Use a simple byte estimation (roughly accurate for UTF-8)
  const jsonString = JSON.stringify(sampleRequest);
  return jsonString.length * 1.2; // Add 20% buffer for formatting variations
}

/**
 * Check if text would create a payload that's too large
 * @param text The text to check
 * @param sourceLang Source language
 * @param targetLang Target language
 * @returns true if payload would be too large
 */
export function isPayloadTooLarge(
  text: string,
  sourceLang: string = "auto",
  targetLang: string = "en"
): boolean {
  const estimatedSize = estimatePayloadSize(text, sourceLang, targetLang);
  return estimatedSize > PAYLOAD_LIMITS.MAX_REQUEST_SIZE;
}

/**
 * Validate text length and suggest appropriate action
 * @param text The text to validate
 * @returns Validation result with suggestions
 */
export function validateTextLength(text: string): {
  isValid: boolean;
  suggestedAction: string;
} {
  const trimmedText = text.trim();

  if (trimmedText.length === 0) {
    return {
      isValid: false,
      suggestedAction: "Text cannot be empty",
    };
  }

  if (trimmedText.length <= PAYLOAD_LIMITS.MAX_TEXT_LENGTH) {
    return {
      isValid: true,
      suggestedAction: "Text is within limits",
    };
  }

  return {
    isValid: false,
    suggestedAction: "Text is too long. Please reduce text length.",
  };
}
