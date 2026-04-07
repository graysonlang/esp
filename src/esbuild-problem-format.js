export function formatDiagnostic({ kind, location, text }) {
  if (location?.file && location.line != null && location.column != null) {
    return `> ${location.file}:${location.line}:${location.column}: ${kind}: ${text}`;
  }
  return `> unknown:1:1: ${kind}: ${text}`;
}

export function printErrorsAndWarnings(result) {
  for (const error of result.errors) {
    console.error(formatDiagnostic({
      kind: 'error',
      location: error.location,
      text: error.text,
    }));
  }

  for (const warning of result.warnings) {
    console.warn(formatDiagnostic({
      kind: 'warning',
      location: warning.location,
      text: warning.text,
    }));
  }
}
