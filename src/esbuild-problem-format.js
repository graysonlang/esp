export function formatDiagnostic({ kind, location, text }) {
  let locString = (location === null)
    ? ''
    : (location?.file && location.line != null && location.column != null)
        ? ` ${location.file}:${location.line}:${location.column}:`
        : ' unknown:1:1:';
  return `>${locString} ${kind}: ${text}`;
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
