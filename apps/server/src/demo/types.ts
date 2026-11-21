/** The demo vault's words in one language (#93yv3ban). Titles are file names too. */
export interface DemoTitles {
  welcome: string;
  folder: string;
  gettingStarted: string;
  graphView: string;
  board: string;
}

export interface DemoCopy extends DemoTitles {
  welcomeBody: (titles: DemoTitles & { boardLink: string }) => string;
  folderBody: string;
  gettingStartedBody: (titles: DemoTitles) => string;
  graphViewBody: (titles: DemoTitles) => string;
  boardFrame: string;
  boardSticky: string;
  boardArrow: string;
}
