export const handleAnthropicError = (error: any) => {
  let errorResult: any;

  if (error.error) {
    errorResult = error.error;

    if ('error' in errorResult) {
      errorResult = errorResult.error;
    }
  } else {
    errorResult = {
      ...(error.cause ? { cause: error.cause } : {}),
      headers: error.headers,
      ...(typeof error.message === 'string' && error.message ? { message: error.message } : {}),
      stack: error.stack,
      status: error.status,
    };
  }

  return { errorResult };
};
