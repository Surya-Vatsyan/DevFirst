import { BrowserRouter } from "react-router-dom";
import { Provider } from "react-redux";
import CssBaseline from "@mui/material/CssBaseline";
import { store } from "./store";
import AppRoutes from "./routes/AppRoutes";

export default function App() {
  return (
    <BrowserRouter>
      <Provider store={store}>
        <CssBaseline />
        <AppRoutes />
      </Provider>
    </BrowserRouter>
  );
}
