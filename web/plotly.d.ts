// plotly.js-dist-min ships no types of its own; it is the same API as plotly.js (typed by @types/plotly.js)
declare module 'plotly.js-dist-min' {
  // eslint-disable-next-line import-x/no-extraneous-dependencies -- type-only, provided by @types/plotly.js
  import * as Plotly from 'plotly.js';

  // eslint-disable-next-line import-x/no-default-export -- mirrors the package's actual default export
  export default Plotly;
}
