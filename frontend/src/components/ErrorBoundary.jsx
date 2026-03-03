import React from "react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  componentDidCatch(error, info) {
    this.setState({ error, info });
    console.group("🔥 React ErrorBoundary caught");
    console.error(error);
    console.log(info?.componentStack);
    console.groupEnd();
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 16 }}>
          <h2>Something crashed.</h2>
          <pre style={{ whiteSpace: "pre-wrap" }}>
            {String(this.state.error)}
            {"\n\n"}
            {this.state.info?.componentStack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
