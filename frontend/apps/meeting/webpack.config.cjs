const HtmlWebpackPlugin = require("html-webpack-plugin");
const path = require("path");
const webpack = require("webpack");
const { ModuleFederationPlugin } = webpack.container;
const dependencies = require("./package.json").dependencies;

const defaultMediaPipeWasmRoot = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const defaultHandModel = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const defaultPoseModel = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const e2eFixtureEnabled = process.env.RECOGNITION_E2E_FIXTURE_ENABLED === "true";
const recognitionSimulatorEnabled = process.env.RECOGNITION_SIMULATOR_ENABLED === "true";

module.exports = {
  entry: "./src/index.ts",
  output: {
    publicPath: "auto",
    clean: true,
    uniqueName: "signconnect-meeting"
  },
  resolve: {
    extensions: [".tsx", ".ts", ".js"]
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: "ts-loader"
      },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"]
      }
    ]
  },
  plugins: [
    ...(!recognitionSimulatorEnabled ? [
      new webpack.NormalModuleReplacementPlugin(
        /recognition[\\/]RecognitionSimulator$/,
        path.resolve(__dirname, "src/recognition/RecognitionSimulator.disabled.tsx")
      )
    ] : []),
    new ModuleFederationPlugin({
      name: "meeting",
      filename: "remoteEntry.js",
      exposes: {
        "./MeetingApp": e2eFixtureEnabled
          ? "./src/recognition/e2eFixtureCapture"
          : "./src/MeetingApp"
      },
      shared: {
        react: { singleton: true, requiredVersion: dependencies.react },
        "react-dom": { singleton: true, requiredVersion: dependencies["react-dom"] }
      }
    }),
    new webpack.DefinePlugin({
      "process.env.MEETING_API_URL": JSON.stringify(process.env.MEETING_API_URL || "http://localhost:8081"),
      "process.env.REALTIME_WS_URL": JSON.stringify(process.env.REALTIME_WS_URL || "ws://localhost:8082"),
      "process.env.MEDIAPIPE_WASM_ROOT_URL": JSON.stringify(
        process.env.MEDIAPIPE_WASM_ROOT_URL || defaultMediaPipeWasmRoot
      ),
      "process.env.MEDIAPIPE_HAND_MODEL_URL": JSON.stringify(
        process.env.MEDIAPIPE_HAND_MODEL_URL || defaultHandModel
      ),
      "process.env.MEDIAPIPE_POSE_MODEL_URL": JSON.stringify(
        process.env.MEDIAPIPE_POSE_MODEL_URL || defaultPoseModel
      ),
      "process.env.RECOGNITION_SIMULATOR_ENABLED": JSON.stringify(
        recognitionSimulatorEnabled ? "true" : "false"
      ),
      "process.env.RECOGNITION_E2E_FIXTURE_ENABLED": JSON.stringify(
        e2eFixtureEnabled ? "true" : "false"
      )
    }),
    new HtmlWebpackPlugin({ template: "./public/index.html" })
  ],
  devServer: {
    port: 3001,
    historyApiFallback: true,
    hot: true,
    client: {
      overlay: {
        errors: true,
        warnings: false
      }
    },
    headers: {
      "Access-Control-Allow-Origin": "*"
    }
  }
};
