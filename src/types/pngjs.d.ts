// pngjs 最小类型声明（宿主依赖无自带类型）
declare module 'pngjs' {
  export interface PNG {
    width: number
    height: number
    data: Buffer
  }
  export class PNG {
    constructor(options?: { width?: number; height?: number })
    static sync: {
      read(buffer: Buffer): PNG
      write(png: PNG): Buffer
    }
  }
}
