// The kit's global `DS`: the design system plus the React it was built with, so prototypes
// share one React instance with the components. React's types use `export =`, which
// `export * as` cannot re-export, hence the namespace imports.
import * as React from 'react';
import * as ReactDOM from 'react-dom/client';

export * from '../src/ds/index.ts';
export { React, ReactDOM };
