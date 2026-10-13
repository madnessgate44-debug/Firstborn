# Keyless Model Reasoning Route Fix

This document confirms that the keyless model route in the FreeLLM configuration now disables reasoning mode. This ensures that top-tier models return usable text output instead of empty responses when operating in keyless mode.

## Problem

Previously, when using keyless routes with certain providers, top-tier models would engage reasoning modes that produced no visible output in the chat completion, causing the model-smoke-test to fail despite successful invocation.

## Solution

The keyless route configuration has been updated to explicitly disable reasoning capabilities, forcing models to return direct textual responses suitable for validation.

## Verification

The fix is validated by the model-smoke-test script, which now passes when run with all provider credentials removed, confirming a usable keyless route exists.

## Impact

- Top-tier models now return usable text in keyless mode
- No degradation in functionality for non-reasoning tasks
- Maintains compatibility with existing keyless provider fallbacks
