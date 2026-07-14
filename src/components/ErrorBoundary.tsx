import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** クラッシュ時に表示する見出し(例: "AIパネルでエラーが発生しました") */
  label: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// 想定外のデータ形状などで子ツリーが描画時に例外を投げても、アプリ全体を巻き込んで
// 画面が真っ黒になるのを防ぐ。捕捉した子ツリーのみフォールバック表示に置き換える。
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`ErrorBoundary(${this.props.label}) caught:`, error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  render(): JSX.Element {
    if (this.state.error) {
      return (
        <div className="dx-error-boundary">
          <p className="dx-error-boundary__title">{this.props.label}</p>
          <p className="dx-error-boundary__message">{this.state.error.message}</p>
          <button type="button" className="dx-error-boundary__retry" onClick={this.handleReset}>
            再試行
          </button>
        </div>
      );
    }
    return <>{this.props.children}</>;
  }
}
